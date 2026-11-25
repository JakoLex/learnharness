/**
 * THE BOOKSHELF (fork, owner 2026-11-24): a reference library of PDFs per
 * project. Unlike notes import, a book never feeds the map: the agents
 * search it (BM25 + embeddings) and read single pages, and their links to a
 * page open it in LH. This module is the pure part, shared by the server
 * (indexing, search, tools) and the client (citation links, page captions).
 *
 * Page numbers: `page` is always the PDF page (1-based). The printed number
 * comes from the PDF's own page labels, or — when it has none — from the
 * optional "first page" the owner sets per book (the PDF page that carries
 * printed page 1).
 */
import { bm25TermScore, bm25Words } from "./bm25.ts";

export const BOOK_ID_PATTERN = /^bk_[a-z0-9]{12}$/;

export type BookStatus = "indexing" | "ready" | "failed";
/** Embeddings: pending = not yet (the PC was unreachable), running, done. */
export type BookVectorState = "pending" | "running" | "done";

export interface BookRecord {
	id: string;
	title: string;
	fileName: string;
	sha256: string;
	bytes: number;
	/** 0 until the PDF was opened. */
	pageCount: number;
	/** The PDF's printed labels, one per PDF page — only when they differ
	 *  from the plain 1..n numbering. */
	pageLabels?: string[];
	/** The PDF page that carries printed page 1 (books without labels). */
	firstPage?: number;
	status: BookStatus;
	/** What read the text. */
	reader?: "doc-loader" | "pdf.js";
	/** Set when the text is weaker than the doc loader's. */
	notice?: string;
	/** Why indexing failed (status failed). */
	error?: string;
	/** The current indexing step, for the shelf page. */
	activity?: string;
	vectors: BookVectorState;
	/** Chunk progress while embedding. */
	embedded?: number;
	chunks?: number;
	/** Why the last embedding attempt stopped. */
	vectorNote?: string;
	/** Fork (owner, 2026-11-25): the notes import (`src_…`) this book is
	 *  linked to — a PDF imported into the graph lands on the shelf too, and
	 *  an import and a book with the same file name are linked. A linked
	 *  book shares its import's on/off switch (core/source-inclusion.ts). */
	sourceId?: string;
	addedAt: string;
	updatedAt: string;
}

/** One page's text, as the reader produced it. */
export interface BookPageText {
	page: number;
	text: string;
}

/** A book page a tool result showed the agent. */
export interface BookPageRef {
	book: string;
	page: number;
}

// ─── page numbers ────────────────────────────────────────────────────────────

/** Labels count only when they say something the PDF page does not. */
export function meaningfulPageLabels(labels: readonly (string | null | undefined)[] | null | undefined): string[] | undefined {
	if (!labels?.length) return undefined;
	const clean = labels.map((label) => (typeof label === "string" ? label.trim() : ""));
	return clean.some((label, i) => label !== String(i + 1)) ? clean : undefined;
}

/** The printed number of a PDF page, or null when none is known. */
export function printedLabel(book: Pick<BookRecord, "pageLabels" | "firstPage">, page: number): string | null {
	if (book.pageLabels?.length) return book.pageLabels[page - 1] || null;
	if (book.firstPage) {
		const printed = page - book.firstPage + 1;
		return printed >= 1 ? String(printed) : null;
	}
	return null;
}

/** "p. 123", or "PDF p. 141" when no printed number is known. */
export function pageCaption(book: Pick<BookRecord, "pageLabels" | "firstPage">, page: number): string {
	const printed = printedLabel(book, page);
	return printed ? `p. ${printed}` : `PDF p. ${page}`;
}

/** The PDF page a printed number names, or null. Without labels or a first
 *  page, printed and PDF numbers are the same. */
export function pdfPageForPrinted(book: Pick<BookRecord, "pageLabels" | "firstPage" | "pageCount">, printed: string): number | null {
	const wanted = printed.trim().toLowerCase();
	if (!wanted) return null;
	if (book.pageLabels?.length) {
		const index = book.pageLabels.findIndex((label) => label.toLowerCase() === wanted);
		return index >= 0 ? index + 1 : null;
	}
	if (!/^\d+$/.test(wanted)) return null;
	const page = Number(wanted) + (book.firstPage ? book.firstPage - 1 : 0);
	return page >= 1 && page <= book.pageCount ? page : null;
}

// ─── keyword search ──────────────────────────────────────────────────────────

// Function words only (English + German): the books are both. Negations
// and domain vocabulary stay searchable.
const BOOK_STOP_WORDS = new Set((
	"a an the and or of to in on at by for from with as is are was were be been being it its this that these those " +
	"which who whose their them they we our you your can could may might must will would should has have had does do did " +
	"such than then when where each every any all also into through " +
	"der die das den dem des ein eine einer eines einem einen und oder von zu im in am an auf aus bei mit nach " +
	"für über unter vor ist sind war waren sein wird werden wurde wurden hat haben hatte es sie er wir ihr ich " +
	"dass daß als wie wenn so auch noch nur sich dies diese dieser dieses jede jeder jedes zum zur durch um"
).split(" "));

export function bookWords(text: string): string[] {
	return bm25Words(text, BOOK_STOP_WORDS).filter((word) => word.length > 1 || /\d/.test(word));
}

export interface BookPageIndex {
	page: number;
	length: number;
	terms: Record<string, number>;
}

/** A book's persisted keyword index: term counts per page. */
export interface BookIndex {
	v: 1;
	pages: BookPageIndex[];
}

export function buildBookIndex(pages: readonly BookPageText[]): BookIndex {
	return {
		v: 1,
		pages: pages.map(({ page, text }) => {
			const words = bookWords(text);
			const terms: Record<string, number> = {};
			for (const word of words) terms[word] = (terms[word] ?? 0) + 1;
			return { page, length: words.length, terms };
		}),
	};
}

export interface RankedPage {
	book: string;
	page: number;
	score: number;
}

/** BM25 over every page of the given books as ONE corpus (document
 *  frequencies across books, so scores compare). Best first. */
export function rankPagesBm25(books: ReadonlyArray<{ book: string; index: BookIndex }>, query: string): RankedPage[] {
	const terms = [...new Set(bookWords(query))];
	if (terms.length === 0) return [];
	let documents = 0;
	let totalLength = 0;
	const df = new Map<string, number>();
	for (const { index } of books) {
		for (const page of index.pages) {
			documents++;
			totalLength += page.length;
			for (const term of terms) if (page.terms[term]) df.set(term, (df.get(term) ?? 0) + 1);
		}
	}
	const averageLength = totalLength / documents || 1;
	const hits: RankedPage[] = [];
	for (const { book, index } of books) {
		for (const page of index.pages) {
			let score = 0;
			for (const term of terms) {
				const tf = page.terms[term];
				if (tf) score += bm25TermScore(tf, df.get(term)!, documents, page.length, averageLength);
			}
			if (score > 0) hits.push({ book, page: page.page, score });
		}
	}
	return hits.sort((a, b) => b.score - a.score || compareRef(a, b));
}

function compareRef(a: BookPageRef, b: BookPageRef): number {
	return a.book < b.book ? -1 : a.book > b.book ? 1 : a.page - b.page;
}

/** Reciprocal rank fusion (k = 60) of page rankings, best first. */
export function fuseRankings(rankings: ReadonlyArray<readonly BookPageRef[]>, k = 60): RankedPage[] {
	const scores = new Map<string, RankedPage>();
	for (const ranking of rankings) {
		ranking.forEach((ref, rank) => {
			const key = `${ref.book}:${ref.page}`;
			const entry = scores.get(key) ?? { book: ref.book, page: ref.page, score: 0 };
			entry.score += 1 / (k + rank + 1);
			scores.set(key, entry);
		});
	}
	return [...scores.values()].sort((a, b) => b.score - a.score || compareRef(a, b));
}

// ─── embeddings ──────────────────────────────────────────────────────────────

export interface BookChunk {
	page: number;
	text: string;
}

/** Pages → embedding chunks of at most `maxWords` words (about 400 tokens),
 *  overlapping by `overlap` words. A chunk never spans two pages. */
export function chunkPages(pages: readonly BookPageText[], maxWords = 300, overlap = 40): BookChunk[] {
	const chunks: BookChunk[] = [];
	for (const { page, text } of pages) {
		const words = text.split(/\s+/).filter(Boolean);
		if (words.length === 0) continue;
		for (let start = 0; ; start += maxWords - overlap) {
			chunks.push({ page, text: words.slice(start, start + maxWords).join(" ") });
			if (start + maxWords >= words.length) break;
		}
	}
	return chunks;
}

/** Scale to unit length, so a dot product is the cosine. */
export function normalizeVector(vector: ArrayLike<number>): Float32Array {
	let sum = 0;
	for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
	const norm = Math.sqrt(sum) || 1;
	const out = new Float32Array(vector.length);
	for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
	return out;
}

/** Pages ranked by their best chunk's cosine to the (unit) query vector. */
export function rankPagesByVector(
	books: ReadonlyArray<{ book: string; chunks: readonly Pick<BookChunk, "page">[]; vectors: Float32Array; dims: number }>,
	query: Float32Array,
): RankedPage[] {
	const best = new Map<string, RankedPage>();
	for (const { book, chunks, vectors, dims } of books) {
		if (dims !== query.length) continue;
		chunks.forEach((chunk, i) => {
			let score = 0;
			const offset = i * dims;
			for (let d = 0; d < dims; d++) score += vectors[offset + d]! * query[d]!;
			const key = `${book}:${chunk.page}`;
			const current = best.get(key);
			if (!current || score > current.score) best.set(key, { book, page: chunk.page, score });
		});
	}
	return [...best.values()].sort((a, b) => b.score - a.score || compareRef(a, b));
}

// ─── snippets ────────────────────────────────────────────────────────────────

/** A short excerpt around the first query word on the page (or its start). */
export function pageSnippet(text: string, query: string, width = 280): string {
	const flat = text.normalize("NFKC").replace(/\s+/g, " ").trim();
	const lower = flat.toLowerCase();
	let at = -1;
	for (const word of bookWords(query)) {
		const found = lower.indexOf(word);
		if (found >= 0 && (at < 0 || found < at)) at = found;
	}
	const start = at < 0 ? 0 : Math.max(0, at - Math.floor(width / 3));
	const end = Math.min(flat.length, start + width);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

// ─── citation links ──────────────────────────────────────────────────────────

/** The link an agent writes for a book page: the project's shelf page with
 *  the book and PDF page — in the chat, a click opens the page viewer. */
export function bookCitationHref(projectId: string, bookId: string, page: number): string {
	return `/p/${encodeURIComponent(projectId)}/books?book=${bookId}&page=${page}`;
}

export function parseBookCitationHref(href: string | undefined | null): { projectId: string; book: string; page: number } | null {
	if (!href || !href.startsWith("/p/")) return null;
	let url: URL;
	try { url = new URL(href, "http://lh.invalid"); } catch { return null; }
	const match = /^\/p\/([^/]+)\/books\/?$/.exec(url.pathname);
	const book = url.searchParams.get("book");
	const page = Number(url.searchParams.get("page"));
	if (!match || !book || !BOOK_ID_PATTERN.test(book) || !Number.isInteger(page) || page < 1) return null;
	let projectId: string;
	try { projectId = decodeURIComponent(match[1]!); } catch { return null; }
	return { projectId, book, page };
}

export const BOOK_TOOL_NAMES = ["search_books", "read_book_page"] as const;

/** Every book page the chat's search_books / read_book_page results showed
 *  the agent, as "bk_…:page" keys — a citation of one of them is verified. */
export function consultedBookPages(messages: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>): Set<string> {
	const seen = new Set<string>();
	for (const message of messages) {
		for (const raw of message.parts ?? []) {
			const part = raw as { type?: unknown; state?: unknown; output?: unknown };
			if (part.type !== "tool-search_books" && part.type !== "tool-read_book_page") continue;
			if (part.state !== "output-available") continue;
			const pages = (part.output as { pages?: unknown } | null | undefined)?.pages;
			if (!Array.isArray(pages)) continue;
			for (const ref of pages) {
				const { book, page } = (ref ?? {}) as { book?: unknown; page?: unknown };
				if (typeof book === "string" && typeof page === "number") seen.add(`${book}:${page}`);
			}
		}
	}
	return seen;
}
