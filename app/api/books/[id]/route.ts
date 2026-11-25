/**
 * PATCH /api/books/[id] {title?, firstPage?} — rename a book, or set the
 * PDF page that carries printed page 1 (null clears it).
 * POST /api/books/[id] — index a failed book again.
 * DELETE /api/books/[id] — remove the book and all its files.
 * DELETE /api/books/[id]?with=import — a linked book together with its
 * notes import and that import's graph contributions (fork, owner
 * 2026-11-25; the Chains deletion with deleteBooks).
 * Fork (owner, 2026-11-24).
 */
import { BookError, deleteSources, editBook, listBooks, removeBook, retryBook, scoped, SourceDeletionError } from "@/src/server";
import { emit } from "@/src/core";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function failure(err: unknown): Response {
	if (err instanceof BookError) return Response.json({ error: err.message }, { status: err.status });
	throw err;
}

async function PATCHHandler(request: Request, { params }: Params) {
	const { id } = await params;
	const body = (await request.json().catch(() => null)) as { title?: unknown; firstPage?: unknown } | null;
	try {
		return Response.json({ book: editBook(id, body ?? {}) });
	} catch (err) {
		return failure(err);
	}
}

async function POSTHandler(_request: Request, { params }: Params) {
	const { id } = await params;
	try {
		return Response.json({ book: retryBook(id) });
	} catch (err) {
		return failure(err);
	}
}

async function DELETEHandler(request: Request, { params }: Params) {
	const { id } = await params;
	const withImport = new URL(request.url).searchParams.get("with") === "import";
	const sourceId = withImport ? listBooks().find((b) => b.id === id)?.sourceId : undefined;
	if (sourceId) {
		try {
			deleteSources({ sourceIds: [sourceId], folderIds: [], deleteSessions: false, deleteBooks: true });
		} catch (err) {
			if (err instanceof SourceDeletionError) return Response.json({ error: err.message, code: err.code }, { status: err.status });
			throw err;
		} finally {
			emit("sources-changed", {}); emit("activity-changed", {});
		}
		removeBook(id); // already gone with its import; harmless
		return Response.json({ ok: true });
	}
	if (!removeBook(id)) return Response.json({ error: "This book is not on the shelf." }, { status: 404 });
	emit("sources-changed", {});
	return Response.json({ ok: true });
}

export const PATCH = scoped(PATCHHandler, { project: "required" });
export const POST = scoped(POSTHandler, { project: "required" });
export const DELETE = scoped(DELETEHandler, { project: "required" });
