/**
 * The bookshelf (fork, owner 2026-11-24): page numbers, keyword + vector
 * ranking, citation links, the fs store, the indexing service (pdf.js path;
 * embeddings faked — no PC in tests), the tools and their registration.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-books-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.DOC_LOADER_URL;
delete process.env.DOC_LOADER_KEY;

const core = await import("../src/core/books.ts");
const { runInDataScope } = await import("../src/store/data-scope.ts");
const books = await import("../src/server/books.ts");
const { stores } = await import("../src/server/stores.ts");
const { bookTools, BOOK_CITATION_RULE } = await import("../src/agent/tools/books.ts");
const { createTeacherTools, createProberTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");
const { CONVERSATION_TOOL_NAMES } = await import("../src/agent/teacher-agent.ts");
const { changeSourceSelection, readSourceSelection } = await import("../src/server/source-selection.ts");
const { deleteSources } = await import("../src/server/source-deletion.ts");
import type { DataScope } from "../src/store/data-scope.ts";

const PDF = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf"));
const scopeFor = (project: string): DataScope => ({
	userId: "usr_books",
	admin: false,
	userRoot: path.join(TMP_DATA, "users", "usr_books"),
	project: { id: project, root: path.join(TMP_DATA, "users", "usr_books", "projects", project) },
});
const inProject = <T>(project: string, fn: () => T): T => runInDataScope(scopeFor(project), fn);

/** Deterministic fake embeddings: word hashes folded into 32 dims. */
function fakeEmbed(texts: string[]): Promise<Float32Array[]> {
	return Promise.resolve(texts.map((text) => {
		const v = new Array<number>(32).fill(0);
		for (const word of core.bookWords(text)) {
			let h = 0;
			for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
			v[h % 32]! += 1;
		}
		return core.normalizeVector(v);
	}));
}

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("book page numbers", () => {
	const labelled = { pageLabels: ["i", "ii", "1", "2", "3"], pageCount: 5 };
	const offset = { firstPage: 3, pageCount: 5 };
	const plain: { pageCount: number; firstPage?: number } = { pageCount: 5 };

	it("uses the PDF's labels, then the first-page offset, then the PDF page", () => {
		assert.equal(core.pageCaption(labelled, 1), "p. i");
		assert.equal(core.pageCaption(labelled, 4), "p. 2");
		assert.equal(core.pageCaption(offset, 4), "p. 2");
		assert.equal(core.pageCaption(offset, 2), "PDF p. 2", "before printed page 1");
		assert.equal(core.pageCaption(plain, 4), "PDF p. 4");
	});

	it("maps a printed number back to the PDF page", () => {
		assert.equal(core.pdfPageForPrinted(labelled, "II"), 2);
		assert.equal(core.pdfPageForPrinted(labelled, "3"), 5);
		assert.equal(core.pdfPageForPrinted(labelled, "9"), null);
		assert.equal(core.pdfPageForPrinted(offset, "2"), 4);
		assert.equal(core.pdfPageForPrinted(offset, "4"), null, "beyond the last page");
		assert.equal(core.pdfPageForPrinted(plain, "4"), 4);
		assert.equal(core.pdfPageForPrinted(plain, "x"), null);
	});

	it("drops labels that only repeat the PDF numbering", () => {
		assert.equal(core.meaningfulPageLabels(["1", "2", "3"]), undefined);
		assert.equal(core.meaningfulPageLabels(null), undefined);
		assert.deepEqual(core.meaningfulPageLabels(["Cover", "1", "2"]), ["Cover", "1", "2"]);
	});
});

describe("book search ranking", () => {
	const a = core.buildBookIndex([
		{ page: 1, text: "Die Kettenregel der Differentialrechnung" },
		{ page: 2, text: "Integration durch Substitution und die Kettenregel rückwärts" },
	]);
	const b = core.buildBookIndex([{ page: 7, text: "The chain rule, explained with examples" }]);

	it("ranks pages of all books as one corpus and ignores stop words", () => {
		const hits = core.rankPagesBm25([{ book: "bk_aaaaaaaaaaaa", index: a }, { book: "bk_bbbbbbbbbbbb", index: b }], "die Kettenregel");
		assert.deepEqual(hits.map((h) => [h.book, h.page]), [["bk_aaaaaaaaaaaa", 1], ["bk_aaaaaaaaaaaa", 2]]);
		assert.deepEqual(core.rankPagesBm25([{ book: "bk_aaaaaaaaaaaa", index: a }], "die und der"), []);
	});

	it("fuses rankings: a page high in both wins", () => {
		const fused = core.fuseRankings([
			[{ book: "bk_x", page: 1 }, { book: "bk_x", page: 2 }],
			[{ book: "bk_x", page: 2 }, { book: "bk_x", page: 3 }],
		]);
		assert.deepEqual(fused.map((r) => r.page), [2, 1, 3]);
	});

	it("chunks pages with overlap, never across pages", () => {
		const words = Array.from({ length: 650 }, (_, i) => `w${i}`).join(" ");
		const chunks = core.chunkPages([{ page: 1, text: words }, { page: 2, text: "short page" }], 300, 40);
		assert.deepEqual(chunks.map((c) => c.page), [1, 1, 1, 2]);
		assert.ok(chunks[1]!.text.startsWith("w260 "));
	});

	it("ranks pages by their best chunk", () => {
		const vectors = new Float32Array([1, 0, 0, 1, 0.6, 0.8]);
		const ranked = core.rankPagesByVector(
			[{ book: "bk_x", chunks: [{ page: 1 }, { page: 2 }, { page: 2 }], vectors, dims: 2 }],
			core.normalizeVector([0, 1]),
		);
		assert.deepEqual(ranked.map((r) => r.page), [2, 1]);
	});

	it("cuts a snippet around the first query word", () => {
		const text = `${"lorem ".repeat(100)}Kettenregel ${"ipsum ".repeat(100)}`;
		const snippet = core.pageSnippet(text, "Kettenregel", 120);
		assert.ok(snippet.startsWith("…") && snippet.endsWith("…"));
		assert.ok(snippet.includes("Kettenregel"));
	});
});

describe("book citation links", () => {
	it("round-trips the shelf link", () => {
		const href = core.bookCitationHref("prj_1", "bk_0123456789ab", 141);
		assert.equal(href, "/p/prj_1/books?book=bk_0123456789ab&page=141");
		assert.deepEqual(core.parseBookCitationHref(href), { projectId: "prj_1", book: "bk_0123456789ab", page: 141 });
		assert.deepEqual(core.parseBookCitationHref("/p/prj_1/books/?page=2&book=bk_0123456789ab"), { projectId: "prj_1", book: "bk_0123456789ab", page: 2 });
	});

	it("rejects anything else", () => {
		for (const href of [
			"https://example.com/p/prj_1/books?book=bk_0123456789ab&page=1",
			"/p/prj_1/chat/x?book=bk_0123456789ab&page=1",
			"/p/prj_1/books?book=bk_nope&page=1",
			"/p/prj_1/books?book=bk_0123456789ab&page=0",
			"/p/prj_1/books?book=bk_0123456789ab",
			undefined,
		]) assert.equal(core.parseBookCitationHref(href), null, String(href));
	});

	it("collects the pages the chat's book tool results showed", () => {
		const seen = core.consultedBookPages([
			{ parts: [
				{ type: "tool-search_books", state: "output-available", output: { pages: [{ book: "bk_a", page: 3 }, { book: "bk_a", page: 9 }] } },
				{ type: "tool-read_book_page", state: "output-error", output: { pages: [{ book: "bk_a", page: 4 }] } },
				{ type: "tool-read", state: "output-available", output: { pages: [{ book: "bk_a", page: 5 }] } },
			] },
			{ parts: [{ type: "tool-read_book_page", state: "output-available", output: { text: "x", pages: [{ book: "bk_b", page: 1 }] } }] },
		]);
		assert.deepEqual([...seen].sort(), ["bk_a:3", "bk_a:9", "bk_b:1"]);
	});
});

describe("the shelf service", () => {
	before(() => { books.bookServiceDeps.embed = (texts) => fakeEmbed(texts); });
	beforeEach(() => fs.rmSync(path.join(TMP_DATA, "users"), { recursive: true, force: true }));

	it("indexes an uploaded PDF with pdf.js, embeds it, and finds it", async () => {
		const { book, duplicate } = inProject("prj_a", () => books.addBook({ name: "Skript.pdf", bytes: new Uint8Array(PDF) }));
		assert.equal(duplicate, false);
		assert.equal(book.status, "indexing");
		assert.equal(book.title, "Skript");
		await books.bookWorkIdle();
		const ready = inProject("prj_a", () => stores.libraryStore.getBook(book.id))!;
		assert.equal(ready.status, "ready", ready.error);
		assert.equal(ready.pageCount, 3);
		assert.equal(ready.reader, "pdf.js");
		assert.match(ready.notice ?? "", /without the doc loader/);
		assert.equal(ready.vectors, "done", ready.vectorNote);

		const pages = inProject("prj_a", () => stores.libraryStore.readPages(book.id))!;
		assert.ok(pages.length > 0);
		const word = core.bookWords(pages[0]!.text).find((w) => w.length > 3)!;
		const result = await inProject("prj_a", () => books.searchBooks(word));
		assert.ok(result.hits.length > 0);
		assert.equal(result.note, undefined);
		const hit = result.hits[0]!;
		assert.equal(hit.href, core.bookCitationHref("prj_a", book.id, hit.page));
		assert.equal(hit.caption, `PDF p. ${hit.page}`);

		const again = inProject("prj_a", () => books.addBook({ name: "copy.pdf", bytes: new Uint8Array(PDF) }));
		assert.equal(again.duplicate, true);
		assert.equal(again.book.id, book.id);
		assert.equal(inProject("prj_b", () => books.listBooks()).length, 0, "another project's shelf is empty");
	});

	it("falls back to keywords when the PC is unreachable", async () => {
		const { book } = inProject("prj_a", () => books.addBook({ name: "Skript.pdf", bytes: new Uint8Array(PDF) }));
		await books.bookWorkIdle();
		books.bookServiceDeps.embed = () => Promise.reject(new books.EmbeddingsUnavailableError("the PC is not reachable"));
		try {
			const pages = inProject("prj_a", () => stores.libraryStore.readPages(book.id))!;
			const word = core.bookWords(pages[0]!.text).find((w) => w.length > 3)!;
			const result = await inProject("prj_a", () => books.searchBooks(word));
			assert.ok(result.hits.length > 0);
			assert.match(result.note ?? "", /Keyword search only/);
		} finally {
			books.bookServiceDeps.embed = (texts) => fakeEmbed(texts);
		}
	});

	it("reads pages by PDF page or printed number and validates", async () => {
		const { book } = inProject("prj_a", () => books.addBook({ name: "Skript.pdf", bytes: new Uint8Array(PDF) }));
		await books.bookWorkIdle();
		inProject("prj_a", () => books.editBook(book.id, { firstPage: 2, title: "Analysis" }));
		const read = inProject("prj_a", () => books.readBookPages(book.id, { printed: "1" }, 5));
		assert.deepEqual(read.map((p) => [p.page, p.caption]), [[2, "p. 1"], [3, "p. 2"]]);
		assert.equal(read[0]!.title, "Analysis");
		assert.throws(() => inProject("prj_a", () => books.readBookPages(book.id, { page: 4 }, 1)), /has 3 pages/);
		assert.throws(() => inProject("prj_a", () => books.readBookPages(book.id, { printed: "9" }, 1)), /no printed page/);
		assert.throws(() => inProject("prj_a", () => books.editBook(book.id, { firstPage: 9 })), /PDF page of this book/);
		assert.equal(inProject("prj_a", () => books.bookFigurePdf(book.id, 3)), inProject("prj_a", () => stores.libraryStore.pdfPath(book.id)));
		assert.throws(() => inProject("prj_a", () => books.bookFigurePdf(book.id, 4)), /does not exist/);
	});

	it("refuses non-PDFs and removes a book with its files", async () => {
		assert.throws(() => inProject("prj_a", () => books.addBook({ name: "notes.pdf", bytes: new TextEncoder().encode("plain text") })), /Only PDF/);
		const { book } = inProject("prj_a", () => books.addBook({ name: "Skript.pdf", bytes: new Uint8Array(PDF) }));
		await books.bookWorkIdle();
		const pdfPath = inProject("prj_a", () => stores.libraryStore.pdfPath(book.id));
		assert.ok(fs.existsSync(pdfPath));
		assert.equal(inProject("prj_a", () => books.removeBook(book.id)), true);
		assert.equal(fs.existsSync(pdfPath), false);
		assert.equal(inProject("prj_a", () => books.listBooks()).length, 0);
		assert.equal(inProject("prj_a", () => books.bookShelfContext()), undefined);
	});
});

describe("the book tools", () => {
	const shelf = {
		books: [{ id: "bk_0123456789ab", title: "Analysis", pageCount: 300 }],
		search: async () => ({
			hits: [{ book: "bk_0123456789ab", title: "Analysis", page: 141, caption: "p. 123", href: "/p/prj_1/books?book=bk_0123456789ab&page=141", snippet: "…Kettenregel…" }],
			note: "Keyword search only: x",
		}),
		read: (_book: string, at: { page?: number }) => [{ book: "bk_0123456789ab", title: "Analysis", page: at.page ?? 1, caption: "p. 1", href: "/p/prj_1/books?book=bk_0123456789ab&page=19", text: null }],
	};

	it("name the shelf and return the pages they showed", async () => {
		const tools = bookTools(shelf);
		assert.match(tools.search_books!.description, /bk_0123456789ab: Analysis \(300 pages\)/);
		const found = await tools.search_books!.execute("c1", { query: "Kettenregel" });
		const text = (found.content[0] as { text: string }).text;
		assert.match(text, /\[Analysis, p\. 123\]\(\/p\/prj_1\/books\?book=bk_0123456789ab&page=141\)/);
		assert.match(text, /Keyword search only/);
		assert.deepEqual((found.details as { pages: unknown }).pages, [{ book: "bk_0123456789ab", page: 141 }]);
		const read = await tools.read_book_page!.execute("c2", { book: "bk_0123456789ab", page: 19 });
		assert.match((read.content[0] as { text: string }).text, /No text was found on this page/);
		assert.deepEqual((read.details as { pages: unknown }).pages, [{ book: "bk_0123456789ab", page: 19 }]);
	});

	it("join every conversation agent's registry only with a shelf", () => {
		const jobs = { chatId: "c1", jobStore: { findJobByToolCallId: () => null } as never, spawn: () => {} };
		const chatStore = { getChat: () => ({ messages: [], kind: "practice" }) } as never;
		const admin: DataScope = { userId: "local", admin: true, userRoot: TMP_DATA };
		runInDataScope(admin, () => {
			for (const withShelf of [false, true]) {
				const extra = withShelf ? { books: shelf } : {};
				const teacher = createTeacherTools({ ...jobs, chatStore, ...extra } as never);
				const prober = createProberTools({ ...jobs, chatStore, deliver: () => {}, ...extra } as never);
				const practice = practiceTools({ chatId: "c1", chatStore, jobs, ...extra } as never);
				for (const registry of [teacher, prober, practice]) {
					assert.equal("search_books" in registry, withShelf);
					assert.equal("read_book_page" in registry, withShelf);
				}
			}
		});
		assert.ok(CONVERSATION_TOOL_NAMES.includes("search_books" as never) && CONVERSATION_TOOL_NAMES.includes("read_book_page" as never));
		assert.match(BOOK_CITATION_RULE, /search_books/);
	});

	it("give visual a book source only with a shelf", async () => {
		const ctx = { chatId: "c1", jobStore: { findJobByToolCallId: () => null } as never, spawn: () => {}, chatStore: { getChat: () => null } as never };
		const admin: DataScope = { userId: "local", admin: true, userRoot: TMP_DATA };
		runInDataScope(admin, () => {
			const plain = createTeacherTools(ctx as never);
			assert.equal("book" in (plain.visual!.parameters as { properties: object }).properties, false);
			const withBooks = createTeacherTools({ ...ctx, books: shelf, bookFigure: () => "/x.pdf" } as never);
			assert.equal("book" in (withBooks.visual!.parameters as { properties: object }).properties, true);
			assert.match(withBooks.visual!.description, /Pass `book`/);
		});
	});
});

describe("imports ↔ books and the tutor's switches (fork, owner 2026-11-25)", () => {	/** The fixture PDF with a trailing comment: still a valid PDF, another hash. */
	const PDF2 = new Uint8Array(Buffer.concat([PDF, Buffer.from("\n% another copy\n")]));
	const importSource = (project: string, id: string, filePath: string) =>
		inProject(project, () => stores.graphStore.upsertSource({ id, filePath, importedAt: new Date().toISOString() }));

	before(() => { books.bookServiceDeps.embed = (texts) => fakeEmbed(texts); });
	beforeEach(() => fs.rmSync(path.join(TMP_DATA, "users"), { recursive: true, force: true }));

	it("an imported PDF lands on the shelf linked; a second import of it is not stored twice", async () => {
		importSource("prj_a", "src_a", "Skripte/Analysis.pdf");
		const book = inProject("prj_a", () => books.shelveImportedPdf("src_a", { name: "Analysis.pdf", bytes: new Uint8Array(PDF) }));
		assert.equal(book.sourceId, "src_a");
		const again = inProject("prj_a", () => books.shelveImportedPdf("src_a", { name: "Analysis.pdf", bytes: new Uint8Array(PDF) }));
		assert.equal(again.id, book.id);
		assert.equal(inProject("prj_a", () => books.listBooks()).length, 1);
		await books.bookWorkIdle();
	});

	it("links an import and a book with the same file name, whichever came first", async () => {
		importSource("prj_a", "src_old", "Mechanik/Newtonsche Mechanik.pdf");
		const { book } = inProject("prj_a", () => books.addBook({ name: "newtonsche mechanik.PDF", bytes: new Uint8Array(PDF) }));
		assert.equal(book.sourceId, "src_old", "a book named like an earlier import");
		const { book: early } = inProject("prj_a", () => books.addBook({ name: "Op_Amp.pdf", bytes: PDF2 }));
		assert.equal(early.sourceId, undefined);
		importSource("prj_a", "src_op", "Labor/Op_Amp.pdf");
		assert.equal(inProject("prj_a", () => books.listBooks()).find((b) => b.id === early.id)?.sourceId, "src_op", "an import named like an earlier book");
		assert.deepEqual(inProject("prj_a", () => books.bookLinks()), {
			src_old: { book: book.id, title: book.title }, src_op: { book: early.id, title: early.title },
		});
		await books.bookWorkIdle();
	});

	it("a switched-off book leaves the agents' shelf; a linked book follows its import's switch", async () => {
		importSource("prj_a", "src_a", "A.pdf");
		const linked = inProject("prj_a", () => books.shelveImportedPdf("src_a", { name: "A.pdf", bytes: new Uint8Array(PDF) }));
		const { book: plain } = inProject("prj_a", () => books.addBook({ name: "B.pdf", bytes: PDF2 }));
		await books.bookWorkIdle();
		const view = inProject("prj_a", () => changeSourceSelection({ changes: [{ kind: "book", id: linked.id, on: false }] }));
		assert.deepEqual(view.off, { sources: ["src_a"], books: [] }, "switching the linked book switches its import");
		const shelf = inProject("prj_a", () => books.bookShelfContext())!;
		assert.deepEqual(shelf.books.map((b) => b.id), [plain.id]);
		assert.equal(shelf.offNote, "(1 book is switched off by the learner.)");
		assert.throws(() => inProject("prj_a", () => shelf.read(linked.id, { page: 1 }, 1)), /switched off by the learner/);
		await assert.rejects(inProject("prj_a", () => shelf.search("Seite", linked.id)), /switched off by the learner/);
		const pages = inProject("prj_a", () => stores.libraryStore.readPages(plain.id))!;
		const word = core.bookWords(pages[0]!.text).find((w) => w.length > 3)!;
		const found = await inProject("prj_a", () => shelf.search(word, undefined));
		assert.ok(found.hits.length > 0 && found.hits.every((h) => h.book === plain.id), "only the switched-on book is searched");
		inProject("prj_a", () => changeSourceSelection({ changes: [{ kind: "book", id: plain.id, on: false }] }));
		const empty = await inProject("prj_a", () => shelf.search(word, undefined));
		assert.equal(empty.hits.length, 0);
		assert.match(empty.note ?? "", /\(2 books are switched off by the learner\.\)/);
	});

	it("deleting an import takes its book along only when asked; a kept book keeps the switch", async () => {
		importSource("prj_a", "src_a", "A.pdf");
		importSource("prj_a", "src_b", "B.pdf");
		const a = inProject("prj_a", () => books.shelveImportedPdf("src_a", { name: "A.pdf", bytes: new Uint8Array(PDF) }));
		const b = inProject("prj_a", () => books.shelveImportedPdf("src_b", { name: "B.pdf", bytes: PDF2 }));
		await books.bookWorkIdle();
		inProject("prj_a", () => changeSourceSelection({ changes: [{ kind: "source", id: "src_a", on: false }] }));
		inProject("prj_a", () => deleteSources({ sourceIds: ["src_a"], folderIds: [], deleteSessions: false, deleteBooks: false }));
		const kept = inProject("prj_a", () => stores.libraryStore.getBook(a.id))!;
		assert.equal(kept.sourceId, undefined, "unlinked");
		assert.deepEqual(inProject("prj_a", () => readSourceSelection()).off, { sources: [], books: [a.id] }, "still off, now as a book; the import's switch is gone");
		inProject("prj_a", () => deleteSources({ sourceIds: ["src_b"], folderIds: [], deleteSessions: false, deleteBooks: true }));
		assert.ok(!inProject("prj_a", () => stores.libraryStore.getBook(b.id)), "the linked book went with its import");
	});
});
