/**
 * PATCH /api/projects/[id] {name?, archived?} — rename / archive / restore.
 * DELETE /api/projects/[id] — delete the project with all its data (409
 * while anything still runs in it). User-level (projects wave).
 */
import { deleteUserProject, scoped, updateUserProject } from "@/src/server";

export const dynamic = "force-dynamic";

async function PATCHHandler(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await request.json().catch(() => null)) as { name?: unknown; archived?: unknown } | null;
	const result = updateUserProject(id, body ?? {});
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	return Response.json({ project: result.project });
}

async function DELETEHandler(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const result = deleteUserProject(id);
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	return Response.json({ ok: true });
}

export const PATCH = scoped(PATCHHandler, { project: "none" });
export const DELETE = scoped(DELETEHandler, { project: "none" });
