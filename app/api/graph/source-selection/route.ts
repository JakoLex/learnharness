/**
 * GET /api/graph/source-selection — the project's switched-off sources and
 * books, plus the import ↔ book links.
 * POST /api/graph/source-selection {changes: [{kind: "source"|"book", id, on}]}
 * — switch sources/books on or off for the chat agents (fork, owner
 * 2026-11-25). Emits sources-changed.
 */
import { changeSourceSelection, readOrganizationAction, readSourceSelection, scoped, SourceOrganizationInputError, SourceSelectionInputError } from "@/src/server";

export const dynamic = "force-dynamic";

async function GETHandler() {
	try { return Response.json(readSourceSelection()); }
	catch { return Response.json({ error: "Could not read the source switches." }, { status: 500 }); }
}

async function POSTHandler(request: Request) {
	try { return Response.json(changeSourceSelection(await readOrganizationAction(request))); }
	catch (error) {
		const input = error instanceof SourceSelectionInputError || error instanceof SourceOrganizationInputError;
		return Response.json({ error: input ? (error as Error).message : "Could not save the source switches." }, { status: input ? 400 : 500 });
	}
}

export const GET = scoped(GETHandler, { project: "required" });
export const POST = scoped(POSTHandler, { project: "required" });
