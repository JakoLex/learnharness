/**
 * THE BOOKSHELF SERVICE (fork, owner 2026-11-24): upload, background
 * indexing, search, page reading and page rendering for the scoped
 * project's books.
 *
 * Indexing, one book at a time per process (it holds the PDF in memory):
 *   1. page count and printed page labels (pdf.js);
 *   2. text per page — the doc loader (Docling on the PC) first, pdf.js
 *      with a notice when it is not configured or not reachable, the same
 *      rule as notes import (documents.ts);
 *   3. the BM25 index → the book is searchable ("ready");
 *   4. embeddings (bge-m3 on llama-swap, CPU on the PC). When the PC is
 *      off they stay "pending" and every later search or shelf listing
 *      tries again; until then the book is keyword-searchable only.
 *
 * Work runs in the scope it was started from (the uploading request's
 * project), so a queued book lands in the right project. A process restart
 * mid-indexing leaves status "indexing"; the next listing restarts it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { currentScope } from "../../config.ts";
import { runInDataScope } from "../store/data-scope.ts";
import {
	bookCitationHref,
	buildBookIndex,
	chunkPages,
	fuseRankings,
	meaningfulPageLabels,
	normalizeVector,
	pageCaption,
	pageSnippet,
	pdfPageForPrinted,
	rankPagesBm25,
	rankPagesByVector,
	type BookChunk,
	type BookIndex,
	type BookPageText,
	type BookRecord,
} from "../core/books.ts";
import { bookLinkKey, sourceSwitches, switchedOffNote, withoutInclusionIds } from "../core/source-inclusion.ts";
import { convertDocument, docLoaderConfigured, DocLoaderFailedError, DocLoaderUnavailableError, sha256 } from "../agent/doc-loader.ts";
import { convertPdf, openPdfBytes } from "../agent/subagents/pdf-ops.ts";
import { renderOpenPdfPage } from "../agent/subagents/headless.ts";
import { llamaSwapUrl } from "../agent/local-providers.ts";
import type { BookPageRead, BookSearchResult, BookShelfContext } from "../agent/tools/books.ts";
import { documentKind } from "./documents.ts";
import { stores } from "./stores.ts";

/** Upload cap (owner: like notes import). */
export const MAX_BOOK_BYTES = 100 * 1024 * 1024;
/** pdf.js fallback's page cap (as for notes import). */
const MAX_PDF_JS_PAGES = 1000;
const SEARCH_LIMIT = 8;
const EMBED_BATCH = 16;
const EMBED_BATCH_TIMEOUT_MS = 180_000;
const QUERY_EMBED_TIMEOUT_MS = 10_000;

export class BookError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

// ─── embeddings ──────────────────────────────────────────────────────────────

export class EmbeddingsUnavailableError extends Error {
	override name = "EmbeddingsUnavailableError";
}

function embedModel(): string {
	return process.env.LH_BOOKS_EMBED_MODEL?.trim() || "bge:m3-q6_k@8k";
}

/** bge-m3 on llama-swap's OpenAI-style /embeddings; unit vectors back. */
async function llamaSwapEmbed(texts: string[], timeoutMs: number, signal?: AbortSignal): Promise<Float32Array[]> {
	const key = process.env.LLAMA_SWAP_KEY?.trim();
	if (!key) throw new EmbeddingsUnavailableError("LLAMA_SWAP_KEY is not set");
	let response: Response;
	try {
		response = await fetch(`${llamaSwapUrl().replace(/\/+$/, "")}/embeddings`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ model: embedModel(), input: texts }),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		signal?.throwIfAborted();
		throw new EmbeddingsUnavailableError(`the PC is not reachable (${(err as Error).message})`);
	}
	if (!response.ok) throw new EmbeddingsUnavailableError(`embeddings HTTP ${response.status}`);
	const body = (await response.json().catch(() => null)) as { data?: Array<{ index?: number; embedding?: number[] }> } | null;
	const data = body?.data;
	if (!Array.isArray(data) || data.length !== texts.length || data.some((d) => !Array.isArray(d.embedding))) {
		throw new EmbeddingsUnavailableError("embeddings answer has the wrong shape");
	}
	return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => normalizeVector(d.embedding!));
}

/** The seams tests replace (no PC in tests). */
export const bookServiceDeps = {
	embed: llamaSwapEmbed,
};

// ─── the work queue ──────────────────────────────────────────────────────────

const queued = new Set<string>();
let queue: Promise<void> = Promise.resolve();

function workKey(kind: string, bookId: string): string {
	return `${kind}:${currentScope().project?.root ?? "-"}:${bookId}`;
}

function enqueue(kind: "index" | "vectors", bookId: string): void {
	const key = workKey(kind, bookId);
	if (queued.has(key)) return;
	queued.add(key);
	const scope = currentScope();
	const work = kind === "index" ? indexBook : embedBook;
	queue = queue
		.then(() => runInDataScope(scope, () => work(bookId)))
		.catch((err) => console.warn(`[books] ${kind} ${bookId}: ${(err as Error).message}`))
		.finally(() => queued.delete(key));
}

/** Resolves when every queued job has run, including work queued
 *  meanwhile (indexing queues the embeddings). Tests. */
export async function bookWorkIdle(): Promise<void> {
	for (let seen = queue; ; seen = queue) {
		await seen;
		if (seen === queue) return;
	}
}

function update(id: string, patch: Partial<BookRecord>): BookRecord | null {
	return stores.libraryStore.updateBook(id, patch);
}

async function indexBook(id: string): Promise<void> {
	const store = stores.libraryStore;
	const book = store.getBook(id);
	if (!book || book.status !== "indexing") return;
	try {
		const bytes = new Uint8Array(fs.readFileSync(store.pdfPath(id)));
		update(id, { activity: "opening the PDF" });
		// pdf.js takes over (detaches) the buffer it is given: every reader
		// below gets its own copy.
		const { doc, task } = await openPdfBytes(bytes.slice());
		let pageCount: number;
		let pageLabels: string[] | undefined;
		try {
			pageCount = doc.numPages;
			pageLabels = meaningfulPageLabels(await doc.getPageLabels().catch(() => null));
		} finally {
			await task.destroy();
		}
		update(id, { pageCount, pageLabels });

		let pages: BookPageText[] = [];
		let reader: BookRecord["reader"];
		let notice: string | undefined;
		let reason = "not configured";
		if (docLoaderConfigured()) {
			update(id, { activity: "reading the pages (doc loader on the PC)" });
			try {
				const result = await convertDocument({ bytes, fileName: book.fileName, contentType: "application/pdf" });
				pages = result.pages
					.filter((p): p is { page: number; text: string } => p.page !== null && p.text.trim().length > 0)
					.map((p) => ({ page: p.page, text: p.text.trim() }));
				if (pages.length) reader = "doc-loader";
				else reason = "the doc loader found no text in this file";
			} catch (err) {
				if (!(err instanceof DocLoaderUnavailableError || err instanceof DocLoaderFailedError)) throw err;
				reason = err.message;
			}
		}
		if (!reader) {
			if (reason !== "not configured") console.warn(`[books] ${book.fileName}: read with pdf.js instead — ${reason}`);
			update(id, { activity: "reading the pages (pdf.js)" });
			const converted = await convertPdf(bytes.slice(), MAX_PDF_JS_PAGES);
			if (converted.kind === "unreadable") throw new Error("Could not open this PDF.");
			if (converted.kind === "too-long") throw new Error(`Too long for pdf.js (max ${MAX_PDF_JS_PAGES} pages) — the doc loader (${reason}) is needed.`);
			pages = converted.pages
				.filter((p): p is { kind: "text"; number: number; markdown: string } => p.kind === "text" && p.markdown.trim().length > 0)
				.map((p) => ({ page: p.number, text: p.markdown.trim() }));
			if (!pages.length) throw new Error(`This PDF has no text layer, and the doc loader (${reason}) is needed to read scanned pages.`);
			reader = "pdf.js";
			notice = `Read without the doc loader (${reason}) — formulas may be garbled and scanned pages are missing.`;
		}
		if (!store.getBook(id)) return void store.deleteBook(id);
		store.writePages(id, pages);
		store.writeIndex(id, buildBookIndex(pages));
		if (!update(id, { status: "ready", reader, notice, activity: undefined, error: undefined })) return void store.deleteBook(id);
		enqueue("vectors", id);
	} catch (err) {
		update(id, { status: "failed", error: (err as Error).message, activity: undefined });
	}
}

async function embedBook(id: string): Promise<void> {
	const store = stores.libraryStore;
	const book = store.getBook(id);
	if (!book || book.status !== "ready" || book.vectors === "done") return;
	const pages = store.readPages(id);
	if (!pages) return;
	const chunks = chunkPages(pages);
	update(id, { vectors: "running", chunks: chunks.length, embedded: 0, vectorNote: undefined });
	try {
		const parts: Float32Array[] = [];
		for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
			if (!store.getBook(id)) return;
			parts.push(...await bookServiceDeps.embed(chunks.slice(i, i + EMBED_BATCH).map((c) => c.text), EMBED_BATCH_TIMEOUT_MS));
			update(id, { embedded: Math.min(i + EMBED_BATCH, chunks.length) });
		}
		const dims = parts[0]?.length ?? 0;
		const vectors = new Float32Array(chunks.length * dims);
		parts.forEach((vector, i) => vectors.set(vector, i * dims));
		if (!store.getBook(id)) return void store.deleteBook(id);
		store.writeVectors(id, chunks, vectors, dims);
		if (!update(id, { vectors: "done", embedded: undefined, chunks: chunks.length })) store.deleteBook(id);
	} catch (err) {
		update(id, { vectors: "pending", embedded: undefined, vectorNote: (err as Error).message });
	}
}

/** Restart what a restart interrupted, and retry embeddings that waited for
 *  the PC. Cheap when nothing is owed. */
function resumeWork(books: readonly BookRecord[]): void {
	for (const book of books) {
		if (book.status === "indexing") enqueue("index", book.id);
		else if (book.status === "ready" && book.vectors !== "done") enqueue("vectors", book.id);
	}
}

// ─── the shelf ───────────────────────────────────────────────────────────────

/** Fork (owner, 2026-11-25): books and notes imports with the same file
 *  name (bookLinkKey) are linked — an import made before the link existed,
 *  or a PDF put on the shelf after its import. A link whose import is gone
 *  is dropped. Writes only what changed; returns the current list. */
function linkedBooks(): BookRecord[] {
	const books = stores.libraryStore.listBooks();
	const sources = stores.graphStore.readSources();
	const sourceIds = new Set(sources.map((s) => s.id));
	const taken = new Set(books.flatMap((b) => (b.sourceId && sourceIds.has(b.sourceId) ? [b.sourceId] : [])));
	let changed = false;
	for (const book of books) {
		if (book.sourceId && sourceIds.has(book.sourceId)) continue;
		const key = bookLinkKey(book.fileName);
		const match = sources
			.filter((s) => !taken.has(s.id) && bookLinkKey(s.filePath) === key)
			.sort((a, b) => a.importedAt.localeCompare(b.importedAt))[0];
		if (match) {
			taken.add(match.id);
			update(book.id, { sourceId: match.id });
			changed = true;
		} else if (book.sourceId) {
			update(book.id, { sourceId: undefined });
			changed = true;
		}
	}
	return changed ? stores.libraryStore.listBooks() : books;
}

/** The shelf page's list; resumes owed work. */
export function listBooks(): BookRecord[] {
	const books = linkedBooks();
	resumeWork(books);
	return books;
}

/** Fork (owner, 2026-11-25): a PDF imported into the graph goes on the
 *  shelf too, linked to its import (`src_…`). A book with the same content
 *  or the same file name that is not linked yet is linked instead of
 *  stored twice. Called once the import has read the file. */
export function shelveImportedPdf(sourceId: string, file: { name: string; bytes: Uint8Array }): BookRecord {
	const books = stores.libraryStore.listBooks();
	const mine = books.find((b) => b.sourceId === sourceId);
	if (mine) return mine;
	const digest = sha256(file.bytes);
	const key = bookLinkKey(file.name);
	const free = books.find((b) => !b.sourceId && b.sha256 === digest) ?? books.find((b) => !b.sourceId && bookLinkKey(b.fileName) === key);
	if (free) return update(free.id, { sourceId })!;
	const { book, duplicate } = addBook(file);
	// The same PDF is already linked to another import: leave that link.
	if (duplicate && book.sourceId) return book;
	return update(book.id, { sourceId })!;
}

/** Deleting an import but keeping its book (owner, 2026-11-25): the link
 *  goes, and the book keeps the import's switch state. */
export function unlinkBook(bookId: string, switchedOff: boolean): void {
	if (!update(bookId, { sourceId: undefined })) return;
	const selection = stores.sourceSelectionStore.read();
	const off = new Set(selection.off.books);
	if (switchedOff === off.has(bookId)) return;
	if (switchedOff) off.add(bookId);
	else off.delete(bookId);
	stores.sourceSelectionStore.write({ version: 1, off: { sources: selection.off.sources, books: [...off].sort() } });
}

/** The import ↔ book links, for the Chains view. */
export function bookLinks(): Record<string, { book: string; title: string }> {
	return Object.fromEntries(linkedBooks().flatMap((b) => (b.sourceId ? [[b.sourceId, { book: b.id, title: b.title }]] : [])));
}

export function addBook(file: { name: string; bytes: Uint8Array }): { book: BookRecord; duplicate: boolean } {
	if (file.bytes.byteLength === 0) throw new BookError("The file is empty.");
	if (file.bytes.byteLength > MAX_BOOK_BYTES) throw new BookError(`Too big. Max ${MAX_BOOK_BYTES / (1024 * 1024)} MB.`, 413);
	if (documentKind(file.name, file.bytes) !== "pdf") throw new BookError("Only PDF files can go on the shelf.");
	const digest = sha256(file.bytes);
	const existing = stores.libraryStore.listBooks().find((b) => b.sha256 === digest);
	if (existing) return { book: existing, duplicate: true };
	const fileName = path.basename(file.name);
	const book = stores.libraryStore.createBook({
		title: fileName.replace(/\.pdf$/i, "") || "Book",
		fileName,
		sha256: digest,
		bytes: file.bytes.byteLength,
		pageCount: 0,
		status: "indexing",
		activity: "waiting",
		vectors: "pending",
	}, file.bytes);
	enqueue("index", book.id);
	// A PDF named like an earlier import is linked to it (owner, 2026-11-25).
	return { book: linkedBooks().find((b) => b.id === book.id) ?? book, duplicate: false };
}

export function editBook(id: string, patch: { title?: unknown; firstPage?: unknown }): BookRecord {
	const book = stores.libraryStore.getBook(id);
	if (!book) throw new BookError("This book is not on the shelf.", 404);
	const next: Partial<BookRecord> = {};
	if (patch.title !== undefined) {
		if (typeof patch.title !== "string" || !patch.title.trim()) throw new BookError("The title must not be empty.");
		next.title = patch.title.trim().slice(0, 200);
	}
	if (patch.firstPage !== undefined) {
		if (patch.firstPage === null) next.firstPage = undefined;
		else if (!Number.isInteger(patch.firstPage) || (patch.firstPage as number) < 1 || (book.pageCount && (patch.firstPage as number) > book.pageCount)) {
			throw new BookError("The first page must be a PDF page of this book.");
		} else next.firstPage = patch.firstPage as number;
	}
	return update(id, next)!;
}

export function removeBook(id: string): boolean {
	if (!stores.libraryStore.getBook(id)) return false;
	const removed = stores.libraryStore.deleteBook(id);
	// Its switch goes with it (fork, owner 2026-11-25).
	const selection = stores.sourceSelectionStore.read();
	if (selection.off.books.includes(id)) stores.sourceSelectionStore.write(withoutInclusionIds(selection, { books: [id] }));
	return removed;
}

/** Index a failed book again. */
export function retryBook(id: string): BookRecord {
	const book = stores.libraryStore.getBook(id);
	if (!book) throw new BookError("This book is not on the shelf.", 404);
	if (book.status !== "failed") return book;
	const next = update(id, { status: "indexing", activity: "waiting", error: undefined })!;
	enqueue("index", id);
	return next;
}

// ─── search and reading ──────────────────────────────────────────────────────

interface LoadedBook {
	stamp: string;
	pages?: Map<number, string>;
	index?: BookIndex | null;
	vectors?: { chunks: BookChunk[]; vectors: Float32Array; dims: number } | null;
}

/** A few books' parsed files, newest use last (Map order). */
const loaded = new Map<string, LoadedBook>();
const LOADED_MAX = 12;

function loadedBook(book: BookRecord): LoadedBook {
	const key = stores.libraryStore.pdfPath(book.id);
	let entry = loaded.get(key);
	if (!entry || entry.stamp !== book.updatedAt) entry = { stamp: book.updatedAt };
	loaded.delete(key);
	loaded.set(key, entry);
	while (loaded.size > LOADED_MAX) loaded.delete(loaded.keys().next().value!);
	return entry;
}

function bookPages(book: BookRecord): Map<number, string> {
	const entry = loadedBook(book);
	entry.pages ??= new Map((stores.libraryStore.readPages(book.id) ?? []).map((p) => [p.page, p.text]));
	return entry.pages;
}

function bookIndex(book: BookRecord): BookIndex | null {
	const entry = loadedBook(book);
	if (entry.index === undefined) entry.index = stores.libraryStore.readIndex(book.id);
	return entry.index;
}

function bookVectors(book: BookRecord) {
	const entry = loadedBook(book);
	if (entry.vectors === undefined) entry.vectors = stores.libraryStore.readVectors(book.id);
	return entry.vectors;
}

function projectId(): string {
	const id = currentScope().project?.id;
	if (!id) throw new Error("No project in scope");
	return id;
}

export async function searchBooks(query: string, onlyBook?: string, signal?: AbortSignal, switchedOn: (book: BookRecord) => boolean = () => true): Promise<BookSearchResult> {
	const all = stores.libraryStore.listBooks();
	resumeWork(all.filter((b) => b.status === "ready" && b.vectors === "pending"));
	if (onlyBook && all.some((b) => b.id === onlyBook && b.status === "ready" && !switchedOn(b))) {
		throw new Error(`The book "${onlyBook}" is switched off by the learner.`);
	}
	const ready = all.filter((b) => b.status === "ready" && switchedOn(b) && (!onlyBook || b.id === onlyBook));
	if (onlyBook && ready.length === 0) throw new Error(`No searchable book "${onlyBook}" on this shelf.`);
	const keyword = rankPagesBm25(
		ready.flatMap((b) => { const index = bookIndex(b); return index ? [{ book: b.id, index }] : []; }),
		query,
	).slice(0, 50);
	const withVectors = ready.flatMap((b) => { const v = bookVectors(b); return b.vectors === "done" && v ? [{ book: b.id, ...v }] : []; });
	let semantic: Awaited<ReturnType<typeof rankPagesByVector>> = [];
	let note: string | undefined;
	if (withVectors.length) {
		try {
			const [vector] = await bookServiceDeps.embed([query], QUERY_EMBED_TIMEOUT_MS, signal);
			semantic = rankPagesByVector(withVectors, vector!).slice(0, 50);
		} catch (err) {
			signal?.throwIfAborted();
			if (!(err instanceof EmbeddingsUnavailableError)) throw err;
			note = "Keyword search only: the meaning search is unavailable right now (the PC is not reachable).";
		}
	}
	if (withVectors.length < ready.length && !note) {
		note = "Some books are keyword-searchable only (their meaning index is not built yet).";
	}
	const byId = new Map(ready.map((b) => [b.id, b]));
	const project = projectId();
	const hits = fuseRankings([keyword, semantic].filter((r) => r.length > 0)).slice(0, SEARCH_LIMIT).map(({ book: id, page }) => {
		const book = byId.get(id)!;
		return {
			book: id,
			title: book.title,
			page,
			caption: pageCaption(book, page),
			href: bookCitationHref(project, id, page),
			snippet: pageSnippet(bookPages(book).get(page) ?? "", query),
		};
	});
	return { hits, ...(note ? { note } : {}) };
}

export function readBookPages(id: string, at: { page?: number; printed?: string }, count: number): BookPageRead[] {
	const book = stores.libraryStore.getBook(id);
	if (!book || book.status !== "ready") throw new Error(`No readable book "${id}" on this shelf.`);
	let start = at.page;
	if (start === undefined && at.printed !== undefined) {
		start = pdfPageForPrinted(book, at.printed) ?? undefined;
		if (start === undefined) throw new Error(`"${book.title}" has no printed page "${at.printed}".`);
	}
	if (start === undefined) throw new Error("Name a page (PDF page) or a printed page number.");
	if (!Number.isInteger(start) || start < 1 || start > book.pageCount) {
		throw new Error(`"${book.title}" has ${book.pageCount} pages; page ${start} does not exist.`);
	}
	const pages = bookPages(book);
	const project = projectId();
	const out: BookPageRead[] = [];
	for (let page = start; page < start + Math.min(Math.max(count, 1), 3) && page <= book.pageCount; page++) {
		out.push({
			book: id,
			title: book.title,
			page,
			caption: pageCaption(book, page),
			href: bookCitationHref(project, id, page),
			text: pages.get(page) ?? null,
		});
	}
	return out;
}

/** The turn's shelf for the agents, or undefined when no book is ready.
 *  Fork (owner, 2026-11-25): switched-off books are left out — the list
 *  (fixed for the turn) only counts them; search and reading check the
 *  switches fresh on every call. */
export function bookShelfContext(): BookShelfContext | undefined {
	const ready = linkedBooks().filter((b) => b.status === "ready");
	if (ready.length === 0) return undefined;
	const switchedOn = (book: BookRecord) => sourceSwitches(stores.sourceSelectionStore.read()).bookOn(book);
	const on = ready.filter(switchedOn);
	return {
		books: on.map((b) => ({ id: b.id, title: b.title, pageCount: b.pageCount })),
		offNote: switchedOffNote(ready.length - on.length, "book"),
		search: async (query, book, signal) => {
			const result = await searchBooks(query, book, signal, switchedOn);
			const off = stores.libraryStore.listBooks().filter((b) => b.status === "ready" && !switchedOn(b)).length;
			const note = result.hits.length === 0 ? switchedOffNote(off, "book") : "";
			return note ? { ...result, note: [result.note, note].filter(Boolean).join("\n") } : result;
		},
		read: (book, at, count) => {
			const record = stores.libraryStore.getBook(book);
			if (record && !switchedOn(record)) throw new Error(`The book "${book}" is switched off by the learner.`);
			return readBookPages(book, at, count);
		},
	};
}

/** visual's book source: the PDF of a book page, validated. */
export function bookFigurePdf(id: string, page: number): string {
	const book = stores.libraryStore.getBook(id);
	if (!book || book.pageCount === 0) throw new Error(`No book "${id}" on this shelf.`);
	if (!Number.isInteger(page) || page < 1 || page > book.pageCount) {
		throw new Error(`"${book.title}" has ${book.pageCount} pages; page ${page} does not exist.`);
	}
	return stores.libraryStore.pdfPath(id);
}

// ─── page images for the viewer ──────────────────────────────────────────────

/** One open PDF at a time, kept briefly so paging through stays quick. */
let openDoc: { file: string; doc: Awaited<ReturnType<typeof openPdfBytes>>["doc"]; destroy: () => Promise<void>; timer?: NodeJS.Timeout } | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();

async function docFor(file: string) {
	if (openDoc?.file === file) {
		clearTimeout(openDoc.timer);
	} else {
		const previous = openDoc;
		openDoc = null;
		await previous?.destroy().catch(() => {});
		const { doc, task } = await openPdfBytes(new Uint8Array(fs.readFileSync(file)));
		openDoc = { file, doc, destroy: task.destroy };
	}
	const current = openDoc!;
	current.timer = setTimeout(() => {
		if (openDoc === current) openDoc = null;
		void current.destroy().catch(() => {});
	}, 60_000);
	current.timer.unref?.();
	return current.doc;
}

/** A page as PNG (cached on disk with the book). */
export async function bookPageImage(id: string, page: number): Promise<Buffer> {
	const book = stores.libraryStore.getBook(id);
	if (!book) throw new BookError("This book is not on the shelf.", 404);
	if (!Number.isInteger(page) || page < 1 || (book.pageCount > 0 && page > book.pageCount)) throw new BookError("No such page.", 404);
	const cached = stores.libraryStore.renderedPagePath(id, page);
	try { return fs.readFileSync(cached); } catch { /* render it */ }
	const file = stores.libraryStore.pdfPath(id);
	const render = renderQueue.then(async () => {
		const doc = await docFor(file);
		if (page > doc.numPages) throw new BookError("No such page.", 404);
		const png = await renderOpenPdfPage(await doc.getPage(page), { dpi: 200, fitLongSide: 1800 });
		if (stores.libraryStore.getBook(id)) {
			fs.mkdirSync(path.dirname(cached), { recursive: true });
			fs.writeFileSync(cached, png);
		}
		return png;
	});
	renderQueue = render.catch(() => {});
	return render;
}
