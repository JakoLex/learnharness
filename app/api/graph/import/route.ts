/**
 * POST /api/graph/import — the format-agnostic front door's transport
 * (vision §1, 2026-09-13): raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files"); the pipeline mints a deterministic source id per file
 * path, persists the source record (the file's provenance + the run's usage),
 * and runs extractor → auditor → merger over the raw text.
 *
 * Only filename extensions listed in lib/notes-import-limits.ts are taken.
 * Among those, documents (a PDF spotted by its %PDF- header; slides, Word,
 * HTML, images by name — fork, 2026-10-29) are read by the doc loader first
 * (src/server/documents.ts); a PDF without it is converted to Markdown by
 * pdf.js (upstream's converter), and one with nothing to extract fails
 * before any model call. Other files are decoded as UTF-8 unless a zero
 * byte in their first 8 KiB causes refusal. This is a binary-file
 * heuristic, not complete text or encoding validation. The type and
 * plain-text refusals occur before any source record or model call.
 *
 * Small concurrency cap: the model calls are the slow part, and a burst of
 * 25 simultaneous runs would trip provider rate limits — a 3-wide worker
 * pool keeps the run registry (the dock's status chips) and the ledgers
 * healthy. The dock's chips + graph refetch track progress live through
 * /api/graph/status, as with session runs.
 */
import { documentKind, extraction, NotesImportError, readDocument, scoped, sourceDirectory } from "@/src/server";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BYTES, TOO_BIG_MESSAGE, UNSUPPORTED_TYPE_MESSAGE, validNotesPath } from "@/lib/notes-import-limits.ts";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data.ts";
import {
	emit,
	ModelsNotConfiguredError,
	PROVIDER_KEY_MISSING_CODE,
	ProviderKeyMissingError,
	type EmissionStats,
} from "@/src/core";

export const dynamic = "force-dynamic";

interface ImportResult {
	requestIndex: number;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	error?: string;
	/** The document was read without the doc loader (src/server/documents.ts). */
	notice?: string;
	/** The machine discriminator when ok:false is a config refusal — the
	 * BYOK models refusal (owner, 2026-09-22) or the provider-key refusal
	 * (2026-09-25); the client can open the setup/keys flow off it. */
	code?: "models_not_configured" | (typeof PROVIDER_KEY_MISSING_CODE);
	missing?: string[];
	/** The key-refusal specifics (provider_key_missing only). */
	provider?: string;
	slots?: string[];
}

async function POSTHandler(request: Request) {
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_IMPORT_BODY_BYTES);
	} catch (err) {
		const oversized = err instanceof FormBodyLimitError;
		return Response.json({ results: [] as ImportResult[], error: oversized
			? "Import request is too large. Select fewer files."
			: "Could not read the upload. It may be incomplete; please select the files again." }, { status: oversized ? 413 : 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) {
		return Response.json({ results: [] as ImportResult[], error: TOO_BIG_MESSAGE }, { status: 413 });
	}
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}

	// PR198: folder-relative identity, matched to either browser filename form.
	// Validate every path before conversions, metadata writes, or model calls.
	const suppliedPaths = form.getAll("paths");
	if (suppliedPaths.length > 0 && (suppliedPaths.length !== files.length || suppliedPaths.some((p) => typeof p !== "string"))) {
		return Response.json({ results: [], error: "Invalid import paths" }, { status: 400 });
	}
	const paths = suppliedPaths.length > 0 ? suppliedPaths as string[] : files.map((f) => f.name);
	if (files.some((file, i) => !validNotesPath(paths[i]!, file.name))) {
		return Response.json({ results: [], error: "Import contains an unsafe or mismatched relative path" }, { status: 400 });
	}
	const results: ImportResult[] = [];
	const queue = files.map((file, requestIndex) => ({ file, requestIndex, filePath: paths[requestIndex]! }));
	const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, requestIndex, filePath } = next;
			let notice: string | undefined;
			try {
				// Off-list names are refused before registerImport or any model call.
				if (!IMPORT_EXTENSIONS.test(file.name)) {
					results.push({ filePath, requestIndex, outcome: "failed", ok: false, error: UNSUPPORTED_TYPE_MESSAGE });
					continue;
				}
				// Documents (PDF by its bytes; slides, Word, images by name) are
				// read by the doc loader inside the import, as its "reading"
				// phase; text files as before, unless they hold a zero byte.
				// The folder placement is registered once the file has been read.
				let input: Parameters<typeof extraction.importNotes>[0];
				const bytes = new Uint8Array(await file.arrayBuffer());
				const kind = documentKind(file.name, bytes);
				if (kind) {
					input = {
						filePath,
						read: async (signal) => {
							const doc = await readDocument({ name: file.name, type: kind === "pdf" ? "application/pdf" : file.type, bytes }, signal);
							notice = doc.notice;
							sourceDirectory.registerImport(filePath);
							return doc;
						},
					};
				} else {
					if (bytes.subarray(0, 8192).includes(0)) {
						results.push({ filePath, requestIndex, outcome: "failed", ok: false, error: "This file isn't plain text." });
						continue;
					}
					sourceDirectory.registerImport(filePath);
					input = { filePath, text: new TextDecoder().decode(bytes) };
				}
				const stats = await extraction.importNotes(input);
				results.push({ filePath, requestIndex, outcome: "completed", ok: true, stats, ...(notice ? { notice } : {}) });
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError) {
					results.push({ filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
						code: "models_not_configured", missing: err.envelope.missing });
				} else if (err instanceof ProviderKeyMissingError) {
					results.push({ filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
						code: PROVIDER_KEY_MISSING_CODE, provider: err.envelope.provider, slots: err.envelope.slots });
				} else {
					results.push({ filePath, requestIndex, ok: false,
						outcome: err instanceof NotesImportError ? err.outcome : "failed",
						...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
						error: err instanceof Error ? err.message : String(err),
						...(notice ? { notice } : {}) });
				}
			} finally { emit("sources-changed", {}); }
		}
	});
	await Promise.all(workers);
	return Response.json({ results });
}

export const POST = scoped(POSTHandler, { project: "required" });
