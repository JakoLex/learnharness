/**
 * THE DOC LOADER (owner, 2026-10-29): a LAN document-extraction service —
 * an Open WebUI "External" loader (`PUT <base>/process`, body = the file,
 * headers X-Filename + Authorization: Bearer <key>) answering a list of
 * {page_content, metadata}. The owner's runs Docling on the CPU, reads
 * formulas as LaTeX and sends scanned pages to a vision model, so it turns
 * PDFs, slides, Word files and images into Markdown.
 *
 * Active when both DOC_LOADER_URL and DOC_LOADER_KEY are set (Settings →
 * Keys, or the launch env). Agent layer: process.env only.
 *
 * Results are cached by the file's SHA-256 under <data>/doc-cache/, and one
 * conversion per file runs at a time: a caller that stops waiting (the PDF
 * reader after 90 s, an aborted import) leaves it running, and the next
 * caller gets the cached pages.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";

/** One page (1-based) — null for formats without pages (slides come as one). */
export interface DocPage {
	page: number | null;
	text: string;
}

export interface DocResult {
	pages: DocPage[];
	/** The pages joined the way the loader shaped them (it ends a page with a
	 *  paragraph break unless a sentence runs on). */
	text: string;
}

/** Not configured, unreachable, or timed out — the caller may fall back. */
export class DocLoaderUnavailableError extends Error {
	override name = "DocLoaderUnavailableError";
}

/** The loader answered, but with an error for this file. */
export class DocLoaderFailedError extends Error {
	override name = "DocLoaderFailedError";
}

/** The longest a single conversion may run (a 100-page scan takes ~20 min). */
const CONVERSION_TIMEOUT_MS = 60 * 60_000;

export function docLoaderConfigured(): boolean {
	return Boolean(process.env.DOC_LOADER_URL?.trim() && process.env.DOC_LOADER_KEY?.trim());
}

function cacheDir(): string {
	return path.join(PATHS.data, "doc-cache");
}

function cachePath(digest: string): string {
	return path.join(cacheDir(), `${digest}.json`);
}

function readCache(digest: string): DocResult | null {
	try {
		const cached = JSON.parse(fs.readFileSync(cachePath(digest), "utf8")) as { v?: number; pages?: DocPage[] };
		if (cached.v !== 1 || !Array.isArray(cached.pages)) return null;
		return withText(cached.pages);
	} catch {
		return null;
	}
}

function writeCache(digest: string, fileName: string, pages: DocPage[]): void {
	try {
		fs.mkdirSync(cacheDir(), { recursive: true });
		const tmp = `${cachePath(digest)}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ v: 1, fileName, convertedAt: new Date().toISOString(), pages }));
		fs.renameSync(tmp, cachePath(digest));
	} catch (err) {
		console.warn(`[doc-loader] cache write failed for ${fileName}: ${(err as Error).message}`);
	}
}

function withText(pages: DocPage[]): DocResult {
	return { pages, text: pages.map((p) => p.text).join("").trim() };
}

/** The loader's answer → pages. Metadata pages are 0-based; empty pages are
 *  omitted by the loader and stay absent here. */
export function parseLoaderResponse(body: unknown): DocPage[] {
	if (!Array.isArray(body)) throw new DocLoaderFailedError("doc loader answered something other than a list");
	return body.map((entry) => {
		const doc = entry as { page_content?: unknown; metadata?: { page?: unknown } };
		if (typeof doc?.page_content !== "string") throw new DocLoaderFailedError("doc loader entry without page_content");
		const page = doc.metadata?.page;
		return { page: typeof page === "number" && Number.isInteger(page) && page >= 0 ? page + 1 : null, text: doc.page_content };
	});
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const running = new Map<string, Promise<DocResult>>();

async function requestConversion(bytes: Uint8Array, fileName: string, contentType: string | undefined, fetchImpl: typeof fetch): Promise<DocPage[]> {
	const base = process.env.DOC_LOADER_URL!.trim().replace(/\/+$/, "");
	const key = process.env.DOC_LOADER_KEY!.trim();
	let response: Response;
	try {
		response = await fetchImpl(`${base}/process`, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": contentType || "application/octet-stream",
				"x-filename": encodeURIComponent(fileName),
			},
			// A fresh ArrayBuffer-backed view: fetch's BodyInit refuses a
			// SharedArrayBuffer-typed Uint8Array.
			body: new Uint8Array(bytes),
			signal: AbortSignal.timeout(CONVERSION_TIMEOUT_MS),
		});
	} catch (err) {
		throw new DocLoaderUnavailableError(`doc loader unreachable: ${(err as Error).message}`, { cause: err });
	}
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 200);
		// 502/503/504: the proxy in front (llama-swap) could not reach or start it.
		const Unavailable = response.status >= 502 && response.status <= 504 ? DocLoaderUnavailableError : DocLoaderFailedError;
		throw new Unavailable(`doc loader HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	return parseLoaderResponse(await response.json().catch(() => {
		throw new DocLoaderFailedError("doc loader answered invalid JSON");
	}));
}

/** The pages of `bytes`, from the cache or the loader. `signal` only ends
 *  THIS caller's wait — the conversion itself runs on and fills the cache. */
export async function convertDocument(input: {
	bytes: Uint8Array;
	fileName: string;
	contentType?: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<DocResult> {
	if (!docLoaderConfigured()) throw new DocLoaderUnavailableError("doc loader not configured (DOC_LOADER_URL / DOC_LOADER_KEY)");
	const digest = sha256(input.bytes);
	const cached = readCache(digest);
	if (cached) return cached;
	let conversion = running.get(digest);
	if (!conversion) {
		const t0 = Date.now();
		conversion = requestConversion(input.bytes, input.fileName, input.contentType, input.fetchImpl ?? fetch)
			.then((pages) => {
				writeCache(digest, input.fileName, pages);
				console.info(`[doc-loader] ${input.fileName}: ${pages.length} page(s) in ${Math.round((Date.now() - t0) / 1000)} s`);
				return withText(pages);
			})
			.finally(() => running.delete(digest));
		running.set(digest, conversion);
		// A caller that stopped waiting must not turn a later failure into an
		// unhandled rejection; every waiting caller still sees it.
		conversion.catch(() => {});
	}
	return waitFor(conversion, input.signal);
}

/** The cached pages for `bytes`, or null — never starts a conversion. */
export function cachedDocument(bytes: Uint8Array): DocResult | null {
	return readCache(sha256(bytes));
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
