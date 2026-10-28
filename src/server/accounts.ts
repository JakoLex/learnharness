import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, currentScope } from "../../config.ts";
import { runInDataScope } from "../store/data-scope.ts";
import {
	accountRoot,
	checkPassword,
	cleanAccountName,
	createAccount,
	createSession,
	deleteAccount,
	endSession,
	endSessionsOf,
	getAccount,
	hasAccounts,
	listAccounts,
	passwordProblem,
	SESSION_COOKIE,
	SESSION_TTL_MS,
	setPassword,
	verifyLogin,
	type Account,
} from "../store/accounts.ts";
import { migrateLegacyLayout } from "../store/projects.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { accountsEnabled, accountUser, DEFAULT_PROJECT_NAME, scopeFor, sessionToken } from "./scope.ts";

/**
 * ACCOUNTS ON THE SERVER (accounts wave, owner-approved 2026-10-28): first
 * setup, sign-in/out, own password, and the admin's account management.
 * Everything here answers JSON envelopes the auth/accounts routes pass
 * through; the session cookie is set and cleared here.
 */

export type AuthResult<T = Record<string, unknown>> =
	| ({ ok: true } & T)
	| { ok: false; status: number; code: string; error: string };

const fail = (status: number, code: string, error: string): AuthResult<never> => ({ ok: false, status, code, error });

export function sessionCookie(token: string): string {
	return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearedSessionCookie(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** An auth envelope as a Response, optionally setting/clearing the cookie. */
export function authResponse(result: AuthResult, cookie?: string): Response {
	const headers: Record<string, string> = { "Cache-Control": "no-store" };
	if (cookie) headers["Set-Cookie"] = cookie;
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status, headers });
	const { ok: _ok, ...body } = result;
	return Response.json(body, { headers });
}

const publicUser = (account: Account) => ({ id: account.id, name: account.name, admin: account.admin });

/** What the shell needs to know about the viewer. */
export function whoAmI(request: Request): { accounts: boolean; setupNeeded: boolean; user: { id: string; name: string; admin: boolean } | null } {
	if (!accountsEnabled()) return { accounts: false, setupNeeded: false, user: { id: "local", name: "local", admin: true } };
	const scope = currentScope();
	const account = getAccount(scope.userId);
	void request;
	return { accounts: true, setupNeeded: !hasAccounts(), user: account ? publicUser(account) : null };
}

/**
 * The account takes over the local data (first setup): a pre-projects flat
 * layout first becomes its first project, then the base's settings.json,
 * prompts/ and projects/ move into the account root. Same-filesystem
 * renames only.
 */
export function adoptLocalData(account: Account): string[] {
	migrateLegacyLayout(PATHS.data, DEFAULT_PROJECT_NAME);
	const root = accountRoot(account.id);
	fs.mkdirSync(root, { recursive: true });
	const moved: string[] = [];
	for (const entry of ["settings.json", "prompts", "projects"]) {
		const from = path.join(PATHS.data, entry);
		if (!fs.existsSync(from)) continue;
		fs.renameSync(from, path.join(root, entry));
		moved.push(entry);
	}
	if (moved.length) console.info(`[accounts] ${account.name} took over the local ${moved.join(", ")}`);
	return moved;
}

/** /setup: the first account — the admin — while none exists. */
export function setupAdmin(body: { name?: unknown; password?: unknown }): AuthResult<{ user: ReturnType<typeof publicUser>; token: string }> {
	if (!accountsEnabled()) return fail(404, "accounts_off", "Accounts are not enabled on this server.");
	if (hasAccounts()) return fail(409, "already_set_up", "This server already has an admin. Sign in instead.");
	const name = cleanAccountName(body.name);
	if (!name) return fail(400, "invalid_name", "Names use 2–32 lowercase letters, digits, - or _.");
	const problem = passwordProblem(body.password);
	if (problem) return fail(400, "invalid_password", problem);
	const account = createAccount(name, body.password as string, true);
	adoptLocalData(account);
	return { ok: true, user: publicUser(account), token: createSession(account.id) };
}

/** Sign in. A failed attempt answers after a short pause. */
export async function signIn(body: { name?: unknown; password?: unknown }): Promise<AuthResult<{ user: ReturnType<typeof publicUser>; token: string }>> {
	if (!accountsEnabled()) return fail(404, "accounts_off", "Accounts are not enabled on this server.");
	const name = cleanAccountName(body.name);
	const account = name && typeof body.password === "string" ? verifyLogin(name, body.password) : null;
	if (!account) {
		await new Promise((resolve) => setTimeout(resolve, 800));
		return fail(401, "bad_credentials", "Wrong name or password.");
	}
	return { ok: true, user: publicUser(account), token: createSession(account.id) };
}

export function signOut(request: Request): void {
	endSession(sessionToken(request));
}

/** The signed-in person changes their own password; their other sessions end. */
export function changeOwnPassword(request: Request, body: { current?: unknown; next?: unknown }): AuthResult {
	const { userId } = currentScope();
	if (typeof body.current !== "string" || !checkPassword(userId, body.current)) {
		return fail(400, "bad_current", "The current password is not right.");
	}
	const problem = passwordProblem(body.next);
	if (problem) return fail(400, "invalid_password", problem);
	setPassword(userId, body.next as string);
	endSessionsOf(userId, sessionToken(request));
	return { ok: true };
}

// ─── The admin's account management ──────────────────────────────────────────

export function accountsForAdmin(): AuthResult<{ accounts: ReturnType<typeof publicUser>[] }> {
	return { ok: true, accounts: listAccounts().map(publicUser) };
}

/** A new account starts with a copy of the creating admin's models
 *  (slots + fallbacks — owner, 2026-10-28) and no projects. */
export function createAccountAsAdmin(body: { name?: unknown; password?: unknown }): AuthResult<{ account: ReturnType<typeof publicUser> }> {
	const name = cleanAccountName(body.name);
	if (!name) return fail(400, "invalid_name", "Names use 2–32 lowercase letters, digits, - or _.");
	const problem = passwordProblem(body.password);
	if (problem) return fail(400, "invalid_password", problem);
	if (listAccounts().some((a) => a.name === name)) return fail(409, "name_taken", `An account named "${name}" already exists.`);
	const models = readSettings()?.models;
	const account = createAccount(name, body.password as string, false);
	if (models) runInDataScope(scopeFor(accountUser(account)), () => writeSettings({ version: 1, models }));
	return { ok: true, account: publicUser(account) };
}

export function resetPasswordAsAdmin(id: string, body: { password?: unknown }): AuthResult {
	if (!getAccount(id)) return fail(404, "account_not_found", "This account does not exist.");
	const problem = passwordProblem(body.password);
	if (problem) return fail(400, "invalid_password", problem);
	setPassword(id, body.password as string);
	endSessionsOf(id);
	return { ok: true };
}

export function deleteAccountAsAdmin(id: string): AuthResult {
	if (id === currentScope().userId) return fail(400, "own_account", "You cannot delete your own account.");
	if (!deleteAccount(id)) return fail(404, "account_not_found", "This account does not exist.");
	return { ok: true };
}
