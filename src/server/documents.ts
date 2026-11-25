/**
 * DOCUMENT IMPORT (owner, 2026-10-29): "Import notes" also takes PDFs,
 * slides, Word files, HTML and images. They go through the doc loader
 * (src/agent/doc-loader.ts) into Markdown with LaTeX before the graph
 * extraction. Without it, a PDF falls back to upstream's pdf.js Markdown
 * converter and the result carries a notice; the other formats fail with a
 * clear message.
 */
import * as path from "node:path";
import { convertDocument, docLoaderConfigured, DocLoaderFailedError, DocLoaderUnavailableError, type DocPage, type LoaderProgress } from "../agent/doc-loader.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";

/** The pdf.js fallback's page cap (upstream's import limit). */
const MAX_PDF_PAGES = 1000;

/** Extensions read through the doc loader; everything else imports as text. */
export const DOCUMENT_EXTENSIONS: readonly string[] = [".pdf", ".pptx", ".docx", ".html", ".htm", ".png", ".jpg", ".jpeg"];

export function isDocumentFile(name: string): boolean {
	return DOCUMENT_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** How an uploaded file is read: a PDF is known by its bytes, not its name
 *  (upstream's rule — a ".pdf" of plain text imports as text); the other
 *  documents by their extension; null = a text file. */
export function documentKind(name: string, bytes: Uint8Array): "pdf" | "other" | null {
	if (PDF_MAGIC.every((byte, i) => bytes[i] === byte)) return "pdf";
	const ext = path.extname(name).toLowerCase();
	return ext !== ".pdf" && DOCUMENT_EXTENSIONS.includes(ext) ? "other" : null;
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
	/** The loader's own progress while it reads (fork, owner 2026-11-25). */
	onProgress?: (progress: LoaderProgress) => void,
): Promise<ReadDocument> {
	const ext = path.extname(file.name).toLowerCase();
	const pdf = ext === ".pdf" || file.type === "application/pdf";
	let reason = "not configured";
	if (docLoaderConfigured()) {
		try {
			const result = await convertDocument({ bytes: file.bytes, fileName: file.name, contentType: file.type, signal, onProgress });
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
	const pdfDoc = await convertPdf(file.bytes, MAX_PDF_PAGES);
	if (pdfDoc.kind === "unreadable") throw new Error("Could not open this PDF.");
	if (pdfDoc.kind === "too-long") throw new Error("Too long. Max 1,000 pages.");
	const text = joinPages(pdfDoc.pages);
	if (!text) {
		throw new Error(`This PDF has no text layer, and the doc loader (${reason}) is needed to read scanned pages.`);
	}
	const skipped = pdfDoc.pages.filter((page) => page.kind === "image-only").length;
	const omission = skipped > 0 ? ` Skipped ${skipped} image-only ${skipped === 1 ? "page" : "pages"}.` : "";
	return { text, notice: `Read without the doc loader (${reason}) — formulas may be garbled and scanned pages are missing.${omission}` };
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
