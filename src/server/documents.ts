/**
 * DOCUMENT IMPORT (owner, 2026-10-29): "Import notes" also takes PDFs,
 * slides, Word files, HTML and images. They go through the doc loader
 * (src/agent/doc-loader.ts) into Markdown with LaTeX before the graph
 * extraction. Without it, a PDF falls back to the pdf.js text layer and the
 * result carries a notice; the other formats fail with a clear message.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { convertDocument, docLoaderConfigured, DocLoaderFailedError, DocLoaderUnavailableError, type DocPage } from "../agent/doc-loader.ts";
import { pdfTextLayer } from "../agent/subagents/pdf-ops.ts";

/** Extensions read through the doc loader; everything else imports as text. */
export const DOCUMENT_EXTENSIONS: readonly string[] = [".pdf", ".pptx", ".docx", ".html", ".htm", ".png", ".jpg", ".jpeg"];

export function isDocumentFile(name: string): boolean {
	return DOCUMENT_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

export interface ReadDocument {
	text: string;
	/** The doc loader's text with `--- Page N ---` markers (2026-10-30) —
	 *  what read_source keeps. Absent when the reader had no pages. */
	pagedText?: string;
	/** Set when the text is weaker than the doc loader's (the pdf.js fallback). */
	notice?: string;
}

export async function readDocument(
	file: { name: string; type?: string; bytes: Uint8Array },
	signal?: AbortSignal,
): Promise<ReadDocument> {
	const ext = path.extname(file.name).toLowerCase();
	const pdf = ext === ".pdf" || file.type === "application/pdf";
	let reason = "not configured";
	if (docLoaderConfigured()) {
		try {
			const result = await convertDocument({ bytes: file.bytes, fileName: file.name, contentType: file.type, signal });
			if (!result.text) throw new DocLoaderFailedError("the doc loader found no text in this file");
			return { text: result.text, ...withPages(result.pages) };
		} catch (err) {
			if (!(err instanceof DocLoaderUnavailableError || err instanceof DocLoaderFailedError)) throw err;
			reason = err.message;
		}
	}
	// Logged (owner, 2026-10-30): the dialog's notice is not the only trace
	// a weaker read leaves. "not configured" is a choice, not a failure.
	const logged = reason !== "not configured";
	if (!pdf) {
		if (logged) console.warn(`[doc-loader] ${file.name}: not readable — ${reason}`);
		throw new Error(reason === "not configured"
			? `${ext} files need the doc loader — set DOC_LOADER_URL and DOC_LOADER_KEY in Settings → Keys.`
			: `${ext} files need the doc loader, which could not read this file: ${reason}`);
	}
	if (logged) console.warn(`[doc-loader] ${file.name}: read with pdf.js instead — ${reason}`);
	const text = await pdfTextLayerOf(file.bytes);
	if (!text.replace(/--- Page \d+ ---/g, "").trim()) {
		throw new Error(`This PDF has no text layer, and the doc loader (${reason}) is needed to read scanned pages.`);
	}
	return { text, notice: `Read without the doc loader (${reason}) — formulas and scanned pages are missing.` };
}

/** The loader's pages with markers, when it numbered them. */
function withPages(pages: DocPage[]): { pagedText?: string } {
	if (!pages.some((p) => p.page !== null)) return {};
	return {
		pagedText: pages
			.map((p) => (p.page === null ? p.text.trim() : `--- Page ${p.page} ---\n${p.text.trim()}`))
			.join("\n\n"),
	};
}

async function pdfTextLayerOf(bytes: Uint8Array): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-import-"));
	try {
		const file = path.join(dir, "document.pdf");
		await fs.writeFile(file, bytes);
		return await pdfTextLayer(file);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}
