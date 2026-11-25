/**
 * The bookshelf's fs adapter (fork, owner 2026-11-24). Layout under the
 * scoped project's library/:
 *
 *   books.json              id → BookRecord
 *   files/<id>.pdf          the uploaded PDF, unchanged
 *   pages/<id>.json         [{ page, text }] — the reader's text per page
 *   index/<id>.bm25.json    the keyword index (BookIndex)
 *   index/<id>.chunks.json  embedding chunks [{ page, text }] + dims
 *   index/<id>.vec          their unit vectors, float32 little-endian
 *   render/<id>/<page>.png  pages rendered for the viewer (a cache)
 *
 * Deleting the project deletes the shelf with it (it lives in the project
 * root).
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { libraryDir } from "../../config.ts";
import { BOOK_ID_PATTERN, type BookChunk, type BookIndex, type BookPageText, type BookRecord } from "../core/books.ts";
import type { LibraryStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

function booksFile(): string {
	return path.join(/* turbopackIgnore: true */ libraryDir(), "books.json");
}

function checkedId(id: string): string {
	if (!BOOK_ID_PATTERN.test(id)) throw new Error(`Invalid book id "${id}"`);
	return id;
}

function filePath(dir: string, name: string): string {
	return path.join(/* turbopackIgnore: true */ libraryDir(), dir, name);
}

function readJson<T>(file: string): T | null {
	try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, JSON.stringify(value));
}

function writeBytes(file: string, bytes: Uint8Array): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${randomUUID()}.tmp`;
	fs.writeFileSync(tmp, bytes);
	fs.renameSync(tmp, file);
}

function readAll(): Record<string, BookRecord> {
	return readJson<Record<string, BookRecord>>(booksFile()) ?? {};
}

function writeAll(books: Record<string, BookRecord>): void {
	fs.mkdirSync(path.dirname(booksFile()), { recursive: true });
	writeFileAtomicSync(booksFile(), JSON.stringify(books, null, "\t") + "\n");
}

export const libraryStore: LibraryStore = {
	listBooks() {
		return Object.values(readAll()).sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id));
	},
	getBook(id) {
		if (!BOOK_ID_PATTERN.test(id)) return null;
		return readAll()[id] ?? null;
	},
	createBook(init, pdf) {
		const books = readAll();
		let id: string;
		do id = `bk_${randomBytes(6).toString("hex")}`; while (books[id]);
		const now = new Date().toISOString();
		writeBytes(filePath("files", `${id}.pdf`), pdf);
		const record: BookRecord = { ...init, id, addedAt: now, updatedAt: now };
		books[id] = record;
		writeAll(books);
		return record;
	},
	updateBook(id, patch) {
		const books = readAll();
		const current = books[id];
		if (!current) return null;
		const next: BookRecord = { ...current, ...patch, id, addedAt: current.addedAt, updatedAt: new Date().toISOString() };
		for (const key of Object.keys(next) as (keyof BookRecord)[]) if (next[key] === undefined) delete next[key];
		books[id] = next;
		writeAll(books);
		return next;
	},
	deleteBook(id) {
		checkedId(id);
		const books = readAll();
		const existed = Boolean(books[id]);
		if (existed) {
			delete books[id];
			writeAll(books);
		}
		// The files go even without a record: an indexing run that finished
		// after the delete may have written them back.
		for (const file of [
			filePath("files", `${id}.pdf`),
			filePath("pages", `${id}.json`),
			filePath("index", `${id}.bm25.json`),
			filePath("index", `${id}.chunks.json`),
			filePath("index", `${id}.vec`),
		]) fs.rmSync(file, { force: true });
		fs.rmSync(filePath("render", id), { recursive: true, force: true });
		return existed;
	},
	pdfPath(id) {
		return filePath("files", `${checkedId(id)}.pdf`);
	},
	writePages(id, pages) {
		writeJson(filePath("pages", `${checkedId(id)}.json`), pages);
	},
	readPages(id) {
		return readJson<BookPageText[]>(filePath("pages", `${checkedId(id)}.json`));
	},
	writeIndex(id, index) {
		writeJson(filePath("index", `${checkedId(id)}.bm25.json`), index);
	},
	readIndex(id) {
		const index = readJson<BookIndex>(filePath("index", `${checkedId(id)}.bm25.json`));
		return index?.v === 1 ? index : null;
	},
	writeVectors(id, chunks, vectors, dims) {
		checkedId(id);
		if (vectors.length !== chunks.length * dims) throw new Error("vector count does not match the chunks");
		const bytes = new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength);
		writeBytes(filePath("index", `${id}.vec`), bytes);
		writeJson(filePath("index", `${id}.chunks.json`), { v: 1, dims, chunks });
	},
	readVectors(id) {
		checkedId(id);
		const meta = readJson<{ v?: number; dims?: number; chunks?: BookChunk[] }>(filePath("index", `${id}.chunks.json`));
		if (meta?.v !== 1 || !meta.dims || !Array.isArray(meta.chunks)) return null;
		let raw: Buffer;
		try { raw = fs.readFileSync(filePath("index", `${id}.vec`)); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		if (raw.byteLength !== meta.chunks.length * meta.dims * 4) return null;
		// Copy into an aligned buffer: a Buffer's offset need not be a multiple of 4.
		const vectors = new Float32Array(raw.byteLength / 4);
		new Uint8Array(vectors.buffer).set(raw);
		return { chunks: meta.chunks, vectors, dims: meta.dims };
	},
	renderedPagePath(id, page) {
		if (!Number.isInteger(page) || page < 1) throw new Error("Invalid page");
		return filePath(path.join("render", checkedId(id)), `${page}.png`);
	},
};
