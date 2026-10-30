/**
 * The doc loader (owner, 2026-10-29): src/agent/doc-loader.ts (client +
 * cache), src/server/documents.ts (the import's reader with the pdf.js
 * fallback), pdf-ops' loader-aware pdf_extract/pdf_search, and the import
 * route's document path. fetch is stubbed — no network.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

const testData = fs.mkdtempSync(join(tmpdir(), "lh-doc-loader-"));
process.env.LH_DATA_DIR = testData;
process.env.LH_AUTH_FILE = join(testData, "auth.json");
const { convertDocument, cachedDocument, docLoaderConfigured, DocLoaderFailedError, DocLoaderUnavailableError, parseLoaderResponse } =
	await import("../src/agent/doc-loader.ts");
const { readDocument, isDocumentFile } = await import("../src/server/documents.ts");
const { pdfExtract, pdfSearch, docLoaderWait } = await import("../src/agent/subagents/pdf-ops.ts");
const { POST } = await import("../app/api/graph/import/route.ts");
const { extraction } = await import("../src/server/index.ts");

const PDF = join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const pdfBytes = () => new Uint8Array(fs.readFileSync(PDF));
const originalFetch = globalThis.fetch;
const originalImport = extraction.importNotes;
const env = process.env as Record<string, string | undefined>;

type Call = { url: string; method?: string; headers: Headers; bytes: number };
let calls: Call[] = [];
let answer: (call: Call) => Promise<Response> | Response = () => Response.json([]);
function stubFetch() {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: String(input), method: init?.method, headers: new Headers(init?.headers), bytes: (init?.body as Uint8Array | undefined)?.byteLength ?? 0 };
		calls.push(call);
		return answer(call);
	}) as typeof fetch;
}
const pages = (...texts: string[]) => texts.map((text, i) => ({ page_content: text, metadata: { page: i, page_label: String(i + 1), total_pages: texts.length, source: "x" } }));

beforeEach(() => {
	calls = [];
	env.DOC_LOADER_URL = "http://loader.test/upstream/doc-loader/";
	env.DOC_LOADER_KEY = "loader-key-0123456789";
	fs.rmSync(join(testData, "doc-cache"), { recursive: true, force: true });
	stubFetch();
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	extraction.importNotes = originalImport;
	docLoaderWait.ms = 90_000;
});
after(() => {
	delete env.DOC_LOADER_URL;
	delete env.DOC_LOADER_KEY;
	fs.rmSync(testData, { recursive: true, force: true });
});

test("configured only with both the URL and the key", () => {
	assert.equal(docLoaderConfigured(), true);
	delete env.DOC_LOADER_KEY;
	assert.equal(docLoaderConfigured(), false);
});

test("PUT <base>/process with the file, its name and the bearer; pages come back 1-based and cached", async () => {
	answer = () => Response.json(pages("Erste Seite $E=mc^2$\n\n", "Zweite Seite"));
	const result = await convertDocument({ bytes: pdfBytes(), fileName: "Skript Übung 1.pdf", contentType: "application/pdf" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "http://loader.test/upstream/doc-loader/process");
	assert.equal(calls[0]!.method, "PUT");
	assert.equal(calls[0]!.headers.get("authorization"), "Bearer loader-key-0123456789");
	assert.equal(calls[0]!.headers.get("x-filename"), encodeURIComponent("Skript Übung 1.pdf"));
	assert.equal(calls[0]!.headers.get("content-type"), "application/pdf");
	assert.equal(calls[0]!.bytes, pdfBytes().byteLength);
	assert.deepEqual(result.pages.map((p) => p.page), [1, 2]);
	assert.equal(result.text, "Erste Seite $E=mc^2$\n\nZweite Seite");
	// Second call: the cache answers, no request.
	const again = await convertDocument({ bytes: pdfBytes(), fileName: "renamed.pdf" });
	assert.equal(calls.length, 1);
	assert.equal(again.text, result.text);
	assert.ok(cachedDocument(pdfBytes()));
});

test("concurrent callers share one conversion", async () => {
	let release!: () => void;
	answer = () => new Promise((resolve) => { release = () => resolve(Response.json(pages("geteilt"))); });
	const a = convertDocument({ bytes: pdfBytes(), fileName: "a.pdf" });
	const b = convertDocument({ bytes: pdfBytes(), fileName: "b.pdf" });
	await new Promise((r) => setTimeout(r, 10));
	release();
	assert.equal((await a).text, "geteilt");
	assert.equal((await b).text, "geteilt");
	assert.equal(calls.length, 1);
});

test("a caller that stops waiting leaves the conversion running into the cache", async () => {
	let release!: () => void;
	answer = () => new Promise((resolve) => { release = () => resolve(Response.json(pages("später fertig"))); });
	const controller = new AbortController();
	const waiting = convertDocument({ bytes: pdfBytes(), fileName: "slow.pdf", signal: controller.signal });
	await new Promise((r) => setTimeout(r, 10));
	controller.abort();
	await assert.rejects(waiting, (err: Error) => err.name === "AbortError");
	release();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(cachedDocument(pdfBytes())?.text, "später fertig");
});

test("errors: unconfigured / unreachable / 502 are 'unavailable', a 500 is 'failed'", async () => {
	delete env.DOC_LOADER_URL;
	await assert.rejects(convertDocument({ bytes: pdfBytes(), fileName: "x.pdf" }), DocLoaderUnavailableError);
	env.DOC_LOADER_URL = "http://loader.test";
	answer = () => { throw new TypeError("fetch failed"); };
	await assert.rejects(convertDocument({ bytes: pdfBytes(), fileName: "x.pdf" }), DocLoaderUnavailableError);
	answer = () => new Response("bad gateway", { status: 502 });
	await assert.rejects(convertDocument({ bytes: pdfBytes(), fileName: "x.pdf" }), DocLoaderUnavailableError);
	answer = () => new Response("conversion failed", { status: 500 });
	await assert.rejects(convertDocument({ bytes: pdfBytes(), fileName: "x.pdf" }), DocLoaderFailedError);
	assert.throws(() => parseLoaderResponse({ nope: true }), DocLoaderFailedError);
	assert.equal(cachedDocument(pdfBytes()), null, "failures are never cached");
});

test("document types: PDF, slides, Word, HTML and images; text stays text", () => {
	for (const name of ["a.pdf", "b.PPTX", "c.docx", "d.html", "e.png", "f.jpeg"]) assert.equal(isDocumentFile(name), true, name);
	for (const name of ["notes.md", "notes.txt", "data.csv"]) assert.equal(isDocumentFile(name), false, name);
});

test("readDocument: the loader's Markdown; without it a PDF falls back to pdf.js with a notice", async () => {
	answer = () => Response.json(pages("## Kapitel\n\n$$\\int_0^1 x\\,dx$$"));
	const viaLoader = await readDocument({ name: "skript.pdf", type: "application/pdf", bytes: pdfBytes() });
	assert.equal(viaLoader.notice, undefined);
	assert.match(viaLoader.text, /\\int_0\^1/);

	fs.rmSync(join(testData, "doc-cache"), { recursive: true, force: true });
	answer = () => { throw new TypeError("connect ECONNREFUSED"); };
	const fallback = await readDocument({ name: "skript.pdf", type: "application/pdf", bytes: pdfBytes() });
	assert.match(fallback.notice ?? "", /without the doc loader \(doc loader unreachable: connect ECONNREFUSED\)/);
	assert.match(fallback.text, /--- Page 1 ---/);
	assert.match(fallback.text, /Calculus page/);

	delete env.DOC_LOADER_KEY;
	const unconfigured = await readDocument({ name: "skript.pdf", bytes: pdfBytes() });
	assert.match(unconfigured.notice ?? "", /not configured/);
	await assert.rejects(readDocument({ name: "folien.pptx", bytes: new Uint8Array([1, 2, 3]) }), /\.pptx files need the doc loader — set DOC_LOADER_URL/);
});

test("readDocument keeps a paged copy of the loader's text for read_source (2026-10-30)", async () => {
	answer = () => Response.json(pages("Erste Seite\n\n", "Zweite Seite"));
	const doc = await readDocument({ name: "skript.pdf", type: "application/pdf", bytes: pdfBytes() });
	assert.equal(doc.text, "Erste Seite\n\nZweite Seite", "the extraction's text is unchanged");
	assert.equal(doc.pagedText, "--- Page 1 ---\nErste Seite\n\n--- Page 2 ---\nZweite Seite");
	// Without page numbers (slides come as one) there is no paged copy.
	fs.rmSync(join(testData, "doc-cache"), { recursive: true, force: true });
	answer = () => Response.json([{ page_content: "Folie eins", metadata: {} }]);
	const slides = await readDocument({ name: "folien.pptx", bytes: pdfBytes() });
	assert.equal(slides.pagedText, undefined);
});

test("a weaker read is logged: pdf.js fallback, unreadable formats, the PDF reader — never 'not configured'", async () => {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
	try {
		answer = () => { throw new TypeError("connect ECONNREFUSED"); };
		await readDocument({ name: "skript.pdf", type: "application/pdf", bytes: pdfBytes() });
		await assert.rejects(readDocument({ name: "folien.pptx", bytes: new Uint8Array([1, 2, 3]) }));
		await pdfExtract(PDF, "1");
		delete env.DOC_LOADER_KEY;
		await readDocument({ name: "plain.pdf", bytes: pdfBytes() });
	} finally {
		console.warn = originalWarn;
	}
	assert.deepEqual(warnings, [
		"[doc-loader] skript.pdf: read with pdf.js instead — doc loader unreachable: connect ECONNREFUSED",
		"[doc-loader] folien.pptx: not readable — doc loader unreachable: connect ECONNREFUSED",
		"[doc-loader] sample-3page.pdf: PDF reader used pdf.js — doc loader unreachable: connect ECONNREFUSED",
	]);
});

test("pdf_extract/pdf_search read the loader's pages, with a source line", async () => {
	answer = () => Response.json(pages("Seite eins mit $\\alpha$", "Seite zwei", "Seite drei: Kraft $F = ma$"));
	const text = await pdfExtract(PDF, "1,3");
	assert.match(text, /^Source: doc loader/);
	assert.match(text, /--- Page 1 ---\nSeite eins mit \$\\alpha\$/);
	assert.match(text, /--- Page 3 ---\nSeite drei: Kraft \$F = ma\$/);
	assert.doesNotMatch(text, /Seite zwei/);
	const { hits } = await pdfSearch(PDF, "Kraft", { literal: true });
	assert.deepEqual(hits.map((h) => h.page), [3]);
	assert.equal(calls.length, 1, "pdf_search reused the cached conversion");
});

test("pdf_extract waits only so long, answers with pdf.js, and a later call gets the loader's text", async () => {
	docLoaderWait.ms = 30;
	let release!: () => void;
	answer = () => new Promise((resolve) => { release = () => resolve(Response.json(pages("Loader eins", "Loader zwei", "Loader drei"))); });
	const first = await pdfExtract(PDF, "1");
	assert.match(first, /^Note: the doc loader is still reading this PDF/);
	assert.match(first, /Calculus page/);
	release();
	await new Promise((r) => setTimeout(r, 20));
	const later = await pdfExtract(PDF, "1");
	assert.match(later, /^Source: doc loader/);
	assert.match(later, /Loader eins/);
	assert.equal(calls.length, 1);
});

test("without a loader, pdf_extract is plain pdf.js as before", async () => {
	delete env.DOC_LOADER_URL;
	const text = await pdfExtract(PDF, "1");
	assert.match(text, /^--- Page 1 ---/);
	assert.equal(calls.length, 0);
});

test("the import route reads a PDF inside importNotes and reports the fallback notice", async () => {
	answer = () => { throw new TypeError("connect EHOSTUNREACH"); };
	let readText = "";
	extraction.importNotes = async (input) => {
		assert.ok("read" in input, "documents arrive as read(), not text");
		readText = (await input.read(new AbortController().signal)).text;
		return { nodes: 1, chains: 0 };
	};
	const form = new FormData();
	form.append("files", new File([pdfBytes()], "skript.pdf", { type: "application/pdf" }));
	form.append("files", new File(["# Notizen"], "notes.md"));
	const response = await POST(new Request("http://localhost/api/graph/import", { method: "POST", body: form }));
	const { results } = await response.json() as { results: Array<{ filePath: string; ok: boolean; notice?: string }> };
	const pdf = results.find((r) => r.filePath === "skript.pdf")!;
	assert.equal(pdf.ok, true);
	assert.match(pdf.notice ?? "", /without the doc loader/);
	assert.match(readText, /Calculus page/);
	assert.equal(results.find((r) => r.filePath === "notes.md")!.notice, undefined);
});
