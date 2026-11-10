/**
 * POST /api/graph/review/undo (fork, owner 2026-11-10) — restore the graph
 * as it was before the last review. 200 { protocol } (status "undone");
 * 409 { error } when it is no longer possible (the graph changed since,
 * a job is running, no finished review).
 */
import { extraction, GraphReviewError, scoped } from "@/src/server";

export const dynamic = "force-dynamic";

async function POSTHandler() {
	try {
		return Response.json({ protocol: extraction.undoReview() });
	} catch (err) {
		if (err instanceof GraphReviewError) return Response.json({ error: err.message }, { status: 409 });
		throw err;
	}
}

export const POST = scoped(POSTHandler, { project: "required" });
