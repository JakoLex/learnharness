/** One import request: file bytes plus a bounded allowance for multipart metadata.
 *  Fork (owner, 2026-11-06): 100 MB instead of upstream's 25, so scanned
 *  scripts and big slide decks fit (the doc loader reads them whole). */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
export const MAX_IMPORT_BODY_BYTES = 101 * 1024 * 1024;
/** The refusal for a file or request over MAX_IMPORT_BYTES. */
export const TOO_BIG_MESSAGE = `Too big. Max ${MAX_IMPORT_BYTES / (1024 * 1024)} MB.`;
/** What "Import notes" takes, single files and folders alike (fork, owner
 *  2026-11-06): text notes, plus the documents the server reads through the
 *  doc loader (src/server/documents.ts DOCUMENT_EXTENSIONS). */
export const IMPORT_FILE_EXTENSIONS: readonly string[] = [".md", ".markdown", ".txt", ".pdf", ".pptx", ".docx", ".html", ".htm", ".png", ".jpg", ".jpeg"];
export const IMPORT_EXTENSIONS = new RegExp(`(?:${IMPORT_FILE_EXTENSIONS.map((ext) => ext.replace(".", "\\.")).join("|")})$`, "i");

/** Contributor's relative-path contract: identity only, never a disk path.
 * Chromium may serialize the basename or the full webkitRelativePath. */
export function validNotesPath(path: string, filename: string): boolean {
	const parts = path.split("/");
	return path.length > 0 && path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(path)
		&& parts.every((part) => part.length > 0 && part !== "." && part !== "..")
		&& (parts.at(-1) === filename || path === filename);
}
