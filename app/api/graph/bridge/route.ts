/**
 * POST /api/graph/bridge — the cross-source pass (fork, 2026-10-27) for
 * sources that are already in the graph. Body (JSON, optional):
 *   { "sourceId": "src_…" }  bridge that one source and wait for the result;
 *   {}                       bridge every imported notes source, in the
 *                            background (202) — the passes serialize behind
 *                            the audit lock and show in the dock as
 *                            "<source>#bridge" rows.
 * Imports bridge on their own when they complete; this door is for the
 * graph that existed before, or after importing a related lecture.
 */
import { extraction, stores, scoped } from "@/src/server";

export const dynamic = "force-dynamic";

async function POSTHandler(request: Request) {
	const body = (await request.json().catch(() => ({}))) as { sourceId?: unknown };
	if (typeof body.sourceId === "string" && body.sourceId.length > 0) {
		try {
			const stats = await extraction.bridgeSource(body.sourceId);
			return Response.json({ sourceId: body.sourceId, stats });
		} catch (err) {
			return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
		}
	}
	const sources = stores.graphStore.readSources().map((s) => s.id);
	void Promise.allSettled(sources.map((id) => extraction.bridgeSource(id)));
	return Response.json({ started: sources }, { status: 202 });
}

export const POST = scoped(POSTHandler, { project: "required" });
