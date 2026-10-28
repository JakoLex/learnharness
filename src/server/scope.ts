import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PATHS, flatFallback } from "../../config.ts";
import { accountRoot, sessionAccount, SESSION_COOKIE, type Account } from "../store/accounts.ts";
import { runInDataScope, type DataScope } from "../store/data-scope.ts";
import { getProject, migrateLegacyLayout, projectRootFor, type ProjectRecord } from "../store/projects.ts";

/**
 * REQUEST SCOPING (projects wave, owner-approved 2026-10-28): every route
 * handler and server page enters the data scope (src/store/data-scope.ts)
 * of its user and, for project-bound work, its project — like
 * OpenScience's per-request project selection. The client names the
 * project with the x-lh-project header (components/api-fetch.ts) or, for
 * the EventSource that cannot set headers, ?project=.
 *
 * Under tests (config.ts flatFallback) a request WITHOUT a project selector
 * runs unscoped — the flat legacy layout — so the suite's route-level
 * tests keep their fixtures; a selector always enters the real scope.
 */

export const PROJECT_HEADER = "x-lh-project";

/** The name the one-time migration gives a user's pre-projects data. */
export const DEFAULT_PROJECT_NAME = "My project";

/** Who a request runs as (the user half of a DataScope). */
export interface ScopeUser {
	userId: string;
	admin: boolean;
	userRoot: string;
}

/** Without accounts: one local user whose root is the data base. */
export function localUser(): ScopeUser {
	return { userId: "local", admin: true, userRoot: PATHS.data };
}

/** Tests (and the LH_FLAT_DATA=1 escape hatch) keep the flat layout —
 *  the same load-time decision config.ts's fallback makes. */
function flatLayout(): boolean {
	return flatFallback.allowed;
}

const settledRoots = new Set<string>();

/** First touch of a user root per process: move a pre-projects flat
 *  layout into its first project (src/store/projects.ts). Never in the
 *  flat layout (tests, LH_FLAT_DATA=1) — it owns its flat fixtures. */
export function ensureUserLayout(userRoot: string): void {
	if (settledRoots.has(userRoot) || flatLayout()) return;
	settledRoots.add(userRoot);
	migrateLegacyLayout(userRoot, DEFAULT_PROJECT_NAME);
}

/** The user scope plus, when `projectId` names one of the user's projects,
 *  that project. undefined project id → user-level scope. */
export function scopeFor(user: ScopeUser, project?: ProjectRecord): DataScope {
	return {
		userId: user.userId,
		admin: user.admin,
		userRoot: user.userRoot,
		...(project ? { project: { id: project.id, root: projectRootFor(user.userRoot, project.id) } } : {}),
	};
}

export type ProjectNeed = "required" | "optional" | "none";

function errorResponse(status: number, code: string, error: string): Response {
	return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Accounts mode (accounts wave, owner-approved 2026-10-28): the server's
 *  env switch. Off — the desktop app, plain dev — means one local user
 *  and no login at all. */
export function accountsEnabled(): boolean {
	return process.env.LH_ACCOUNTS === "1";
}

/** The session token a request carries (its Cookie header). */
export function sessionToken(request: Request | undefined): string | undefined {
	const header = request?.headers.get("cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === SESSION_COOKIE) return decodeURIComponent(value.join("="));
	}
	return undefined;
}

/** An account as the user half of a scope. */
export function accountUser(account: Account): ScopeUser {
	return { userId: account.id, admin: account.admin, userRoot: accountRoot(account.id) };
}

/** The user a request runs as: the local user without accounts, else the
 *  signed-in account (a 401 response when nobody is). Pages pass no
 *  request — their cookie comes from next/headers. */
export async function requestUser(request: Request | undefined): Promise<ScopeUser | Response> {
	if (!accountsEnabled()) return localUser();
	const token = request ? sessionToken(request) : (await cookies()).get(SESSION_COOKIE)?.value;
	const account = sessionAccount(token);
	if (!account) return errorResponse(401, "auth_required", "Please sign in.");
	return accountUser(account);
}

/** The project selector a request carries (header first, then ?project=). */
export function requestedProjectId(request: Request | undefined): string | null {
	if (!request) return null;
	return request.headers.get(PROJECT_HEADER) ?? new URL(request.url).searchParams.get("project");
}

/**
 * Wrap a route handler so it runs in its request's scope. `project`:
 * "required" — the request must name one of the user's projects (400/404
 * otherwise); "optional" — project-bound when named, user-level when not;
 * "none" — always user-level.
 */
export function scoped<A extends unknown[]>(
	handler: (...args: A) => Response | Promise<Response>,
	options: { project: ProjectNeed; admin?: boolean },
): (...args: A) => Promise<Response> {
	return async (...args: A): Promise<Response> => {
		const request = args[0] instanceof Request ? args[0] : undefined;
		const user = await requestUser(request);
		if (user instanceof Response) return user;
		// Admin-only surfaces (keys, provider logins, accounts).
		if (options.admin && !user.admin) return errorResponse(403, "admin_only", "Only the admin can do this.");
		const projectId = options.project === "none" ? null : requestedProjectId(request);
		// Tests without accounts: no selector → the flat fallback (see the
		// module doc). With accounts the user scope always applies.
		if (flatLayout() && !projectId && !accountsEnabled()) return handler(...args);
		ensureUserLayout(user.userRoot);
		let project: ProjectRecord | undefined;
		if (projectId) {
			project = getProject(user.userRoot, projectId) ?? undefined;
			if (!project) return errorResponse(404, "project_not_found", "This project does not exist.");
		} else if (options.project === "required") {
			return errorResponse(400, "project_required", "Choose a project first.");
		}
		return runInDataScope(scopeFor(user, project), () => handler(...args));
	};
}

/** Run a server page's data reads as the local/signed-in user, in
 *  `projectId` when given. Returns null when the project does not exist
 *  (the page answers notFound()). */
export async function withPageScope<T>(projectId: string | null, fn: (project: ProjectRecord | undefined) => Promise<T> | T): Promise<{ value: T } | null> {
	const user = await requestUser(undefined);
	// Signed out (accounts mode): every page but /login and /setup sends
	// the browser there (proxy.ts already does for a missing cookie; this
	// covers an expired or revoked one).
	if (user instanceof Response) redirect("/login");
	ensureUserLayout(user.userRoot);
	let project: ProjectRecord | undefined;
	if (projectId) {
		project = getProject(user.userRoot, projectId) ?? undefined;
		if (!project) return null;
	}
	return { value: await runInDataScope(scopeFor(user, project), () => fn(project)) };
}
