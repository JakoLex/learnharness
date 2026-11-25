/**
 * THE BOOKSHELF TOOLS (fork, owner 2026-11-24): search_books and
 * read_book_page over the project's books — the teacher's, the prober's
 * and the practice agent's. The server builds the shelf context per turn
 * (src/server/books.ts); the tools are registered only when the project
 * has a ready book, so their descriptions can name the books.
 *
 * Both results carry `details.pages` — every book page the result showed
 * the agent. The chat marks a citation link verified when its page is
 * among them (core/books.ts consultedBookPages).
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BookPageRef } from "../../core/books.ts";
import { serverExecute } from "../tool-execute.ts";

export interface BookShelfSummary {
	id: string;
	title: string;
	pageCount: number;
}

export interface BookSearchHit {
	book: string;
	title: string;
	page: number;
	caption: string;
	href: string;
	snippet: string;
}

export interface BookSearchResult {
	hits: BookSearchHit[];
	/** Said to the agent under the hits (e.g. keyword search only). */
	note?: string;
}

export interface BookPageRead {
	book: string;
	title: string;
	page: number;
	caption: string;
	href: string;
	/** null: the reader found no text on this page. */
	text: string | null;
}

/** What the server hands the tools for one turn. */
export interface BookShelfContext {
	/** The switched-on books (fork, owner 2026-11-25). */
	books: readonly BookShelfSummary[];
	/** "(2 books are switched off by the learner.)", or empty. */
	offNote?: string;
	search(query: string, book: string | undefined, signal?: AbortSignal): Promise<BookSearchResult>;
	/** `page` (PDF page) wins over `printed`; throws on an unknown book or page. */
	read(book: string, at: { page?: number; printed?: string }, count: number): BookPageRead[];
}

/** Appended to the agent's system prompt whenever the book tools are in
 *  its registry. */
export const BOOK_CITATION_RULE = [
	"## The project's bookshelf",
	"",
	"search_books finds passages in the books the learner put on this project's shelf; read_book_page reads whole pages. " +
		"Reach for them when the learner's own textbook should ground an explanation, a problem or a check.",
	"",
	"When you use something from a book, cite the page with the markdown link the tool result gives — e.g. " +
		"`[Title, p. 123](/p/…/books?book=bk_…&page=141)` — and keep the link target exactly as given; the label text may be " +
		"in the learner's language. The learner clicks it to open the page. Cite only pages a search_books or read_book_page " +
		"result in this chat showed you: a link to any other page is marked as not looked up. Never invent page numbers.",
].join("\n");

const searchInput = Type.Object({
	query: Type.String({ minLength: 1, description: "What to look for — words, a formula name, a concept, a question." }),
	book: Type.Optional(Type.String({ description: "Search only this book (its bk_… id). Omit to search the whole shelf." })),
});

const readInput = Type.Object({
	book: Type.String({ description: "The book's bk_… id." }),
	page: Type.Optional(Type.Integer({ minimum: 1, description: "The PDF page — the number after page= in a link from search_books." })),
	printed: Type.Optional(Type.String({ description: "The printed page number as it appears in the book (e.g. \"123\" or \"xii\"), when the learner names one. Used only without page." })),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "How many consecutive pages to read (1–3, default 1)." })),
});

function shelfList(books: readonly BookShelfSummary[], offNote?: string): string {
	const lines = books.length ? books.map((b) => `- ${b.id}: ${b.title} (${b.pageCount} pages)`) : ["(none switched on)"];
	return [...lines, ...(offNote ? [offNote] : [])].join("\n");
}

function refs(items: ReadonlyArray<{ book: string; page: number }>): BookPageRef[] {
	return items.map(({ book, page }) => ({ book, page }));
}

export function bookTools(shelf: BookShelfContext): Record<string, AgentTool<any>> {
	const list = shelfList(shelf.books, shelf.offNote);
	return {
		search_books: {
			name: "search_books",
			label: "search_books",
			description:
				"Search the books on this project's shelf (keywords plus meaning). Returns up to 8 pages, best first, each with the " +
				"book, its page, a short excerpt and the markdown link to cite it with. Read a page in full with read_book_page.\n" +
				`Books on the shelf:\n${list}`,
			parameters: searchInput,
			execute: serverExecute("search_books", searchInput, async ({ query, book }, { signal }) => {
				const result = await shelf.search(query, book, signal);
				const lines = result.hits.map((hit, i) =>
					`${i + 1}. [${hit.title}, ${hit.caption}](${hit.href}) — PDF page ${hit.page} of ${hit.book}\n   ${hit.snippet}`);
				const text = [
					lines.length ? lines.join("\n") : `No page matched "${query}".`,
					...(result.note ? ["", result.note] : []),
				].join("\n");
				return { text, details: { text, pages: refs(result.hits) } };
			}),
		},
		read_book_page: {
			name: "read_book_page",
			label: "read_book_page",
			description:
				"Read up to 3 consecutive pages of a book on this project's shelf, as text. Name the page by its PDF page (from a " +
				"search_books link) or, when the learner names a page, by its printed number. Each page comes with the markdown " +
				"link to cite it with.",
			parameters: readInput,
			execute: serverExecute("read_book_page", readInput, ({ book, page, printed, count }) => {
				const pages = shelf.read(book, { page, printed }, count ?? 1);
				const text = pages.map((p) => [
					`## ${p.title} — ${p.caption} (PDF page ${p.page})`,
					`Cite as: [${p.title}, ${p.caption}](${p.href})`,
					"",
					p.text ?? "(No text was found on this page — it may be a figure or a scan. The learner can open it with the link.)",
				].join("\n")).join("\n\n");
				return { text, details: { text, pages: refs(pages) } };
			}),
		},
	};
}
