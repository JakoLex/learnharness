/**
 * GET /api/projects — the user's projects (archived included; the list
 * filters), most recent activity first. POST {name} — create one.
 * User-level (projects wave, owner-approved 2026-10-28).
 */
import { createUserProject, projectsOfUser, scoped } from "@/src/server";

export const dynamic = "force-dynamic";

async function GETHandler() {
	return Response.json({ projects: projectsOfUser() });
}

async function POSTHandler(request: Request) {
	const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
	const result = createUserProject(body?.name);
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	return Response.json({ project: result.project }, { status: 201 });
}

export const GET = scoped(GETHandler, { project: "none" });
export const POST = scoped(POSTHandler, { project: "none" });
