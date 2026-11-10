/**
 * The graph review (fork, owner 2026-11-10).
 *   GET  → 200 { protocol } — the last review's protocol, or null.
 *   POST → 202 { protocol } — starts a review in the background (dock row
 *          "Graph review"); 409 { error } when it cannot start (an import or
 *          extraction is running, models not configured, empty graph).
 * The review finds duplicates, errors and broken chains, adds missing
 * bridges, applies everything automatically and can be undone through
 * POST /api/graph/review/undo. See src/agent/subagents/extraction.ts.
 */
import { extraction, GraphReviewError, scoped } from "@/src/server";
import { ModelsNotConfiguredError, PROVIDER_KEY_MISSING_CODE, ProviderKeyMissingError } from "@/src/core";

export const dynamic = "force-dynamic";

async function GETHandler() {
	return Response.json({ protocol: extraction.readReview() });
}

async function POSTHandler() {
	try {
		return Response.json({ protocol: extraction.startReview() }, { status: 202 });
	} catch (err) {
		if (err instanceof GraphReviewError) return Response.json({ error: err.message }, { status: 409 });
		if (err instanceof ModelsNotConfiguredError)
			return Response.json({ error: err.envelope.error, code: "models_not_configured", missing: err.envelope.missing }, { status: 409 });
		if (err instanceof ProviderKeyMissingError)
			return Response.json({ error: err.envelope.error, code: PROVIDER_KEY_MISSING_CODE, provider: err.envelope.provider }, { status: 409 });
		throw err;
	}
}

export const GET = scoped(GETHandler, { project: "required" });
export const POST = scoped(POSTHandler, { project: "required" });
