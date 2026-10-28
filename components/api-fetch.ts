/**
 * THE CLIENT'S API CALL (projects wave, owner-approved 2026-10-28): fetch
 * for /api routes, naming the window's project — the one /p/<id> in the
 * current URL — in the x-lh-project header the server scopes every
 * request by (src/server/scope.ts). Outside a project (the project list)
 * it is plain fetch: those routes are user-level.
 */

import { projectIdFromPath } from "./project-paths.ts";

const PROJECT_HEADER = "x-lh-project";

/** The project the window shows, from its URL (null outside a project). */
export function currentProjectId(): string | null {
	if (typeof window === "undefined") return null;
	return projectIdFromPath(window.location?.pathname);
}

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const projectId = currentProjectId();
	// globalThis receiver: browsers' native fetch rejects any other `this`.
	if (!projectId) return globalThis.fetch(input, init);
	const headers = new Headers(init?.headers);
	headers.set(PROJECT_HEADER, projectId);
	return globalThis.fetch(input, { ...init, headers });
}

/** An /api URL for contexts that cannot set headers (EventSource, a
 *  download link): the project rides as ?project=. */
export function apiUrlWithProject(url: string, projectId: string | null = currentProjectId()): string {
	if (!projectId) return url;
	return `${url}${url.includes("?") ? "&" : "?"}project=${encodeURIComponent(projectId)}`;
}
