/** Project URL helpers (projects wave, 2026-10-28) — pure, so plain
 *  modules and tests can use them without React (project-route.tsx
 *  re-exports them beside the hooks). */

const PROJECT_PATH = /^\/p\/([^/]+)/;

/** The project id a path belongs to, or null outside any project. */
export function projectIdFromPath(pathname: string | null | undefined): string | null {
	const match = pathname ? PROJECT_PATH.exec(pathname) : null;
	return match ? decodeURIComponent(match[1]!) : null;
}

/** A path inside a project: projectHref(id, "/chat/new") → /p/<id>/chat/new. */
export function projectHref(projectId: string, path = ""): string {
	return `/p/${encodeURIComponent(projectId)}${path}`;
}
