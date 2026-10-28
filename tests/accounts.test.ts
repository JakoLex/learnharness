import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

// Accounts (accounts wave, owner-approved 2026-10-28). Setup moves the
// data base's records, so this file owns its own data dir — set BEFORE
// any config-loading import (the birth-stamp discipline).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-accounts-"));
process.env.LH_DATA_DIR = TMP_DATA;

const store = await import("../src/store/accounts.ts");
const { runInDataScope, activeDataScope } = await import("../src/store/data-scope.ts");
const { scoped, scopeFor, accountUser, sessionToken } = await import("../src/server/scope.ts");
const accounts = await import("../src/server/accounts.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { listProjects } = await import("../src/store/projects.ts");
const { createTeacherTools, createProberTools, hostFileAccess } = await import("../src/agent/tools.ts");
const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");
const { accountSectionIds } = await import("../components/settings/account-section.tsx");
const { visibleSectionIds } = await import("../components/settings/settings-dialog.tsx");
import type { DataScope } from "../src/store/data-scope.ts";

const ON = () => {
	process.env.LH_ACCOUNTS = "1";
};
afterEach(() => {
	delete process.env.LH_ACCOUNTS;
	for (const entry of fs.readdirSync(TMP_DATA)) fs.rmSync(path.join(TMP_DATA, entry), { recursive: true, force: true });
});
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const cookie = (token: string) => ({ cookie: `other=1; ${store.SESSION_COOKIE}=${encodeURIComponent(token)}` });

describe("accounts store", () => {
	it("hashes with scrypt and verifies in constant time", () => {
		const hash = store.hashPassword("correct horse");
		assert.match(hash, /^scrypt\$16384\$8\$1\$/);
		assert.equal(store.verifyPasswordHash("correct horse", hash), true);
		assert.equal(store.verifyPasswordHash("wrong horse", hash), false);
		assert.notEqual(store.hashPassword("correct horse"), hash, "salted");
	});

	it("names and passwords have rules", () => {
		assert.equal(store.cleanAccountName("  Jana "), "jana");
		assert.equal(store.cleanAccountName("a"), null);
		assert.equal(store.cleanAccountName("no spaces"), null);
		assert.match(store.passwordProblem("short") ?? "", /at least 8/);
		assert.equal(store.passwordProblem("long enough"), null);
	});

	it("sign-in, sessions (stored hashed), sliding expiry, sign-out", () => {
		const account = store.createAccount("jana", "password-1", false);
		assert.equal(store.verifyLogin("jana", "password-1")?.id, account.id);
		assert.equal(store.verifyLogin("jana", "nope-nope"), null);
		assert.equal(store.verifyLogin("nobody", "password-1"), null);
		const now = Date.now();
		const token = store.createSession(account.id, now);
		const raw = fs.readFileSync(path.join(TMP_DATA, "sessions.json"), "utf-8");
		assert.ok(!raw.includes(token), "only the token's hash is stored");
		assert.equal(store.sessionAccount(token, now)?.id, account.id);
		assert.equal(store.sessionAccount(token, now + store.SESSION_TTL_MS + 1), null, "expired");
		const fresh = store.createSession(account.id, now);
		assert.equal(store.sessionAccount(fresh, now + 5 * 86_400_000)?.id, account.id, "use slides the expiry");
		assert.equal(store.sessionAccount(fresh, now + store.SESSION_TTL_MS + 86_400_000)?.id, account.id);
		store.endSession(fresh);
		assert.equal(store.sessionAccount(fresh), null);
		assert.equal(store.sessionAccount(undefined), null);
	});
});

describe("first setup", () => {
	it("the admin takes over the local data: flat records become a project, settings move along", async () => {
		ON();
		fs.mkdirSync(path.join(TMP_DATA, "chats"));
		fs.writeFileSync(path.join(TMP_DATA, "chats", "chat_x.json"), "{}");
		fs.writeFileSync(path.join(TMP_DATA, "settings.json"), JSON.stringify({ version: 1, general: { autoUpdate: false } }));
		const result = accounts.setupAdmin({ name: "ada", password: "password-1" });
		assert.ok(result.ok);
		const root = store.accountRoot(result.user.id);
		assert.equal(result.user.admin, true);
		assert.ok(fs.existsSync(path.join(root, "settings.json")));
		const [project] = listProjects(root);
		assert.equal(project?.name, "My project");
		assert.equal(project?.chatCount, 1);
		assert.equal(fs.existsSync(path.join(TMP_DATA, "chats")), false);
		assert.equal(store.sessionAccount(result.token)?.name, "ada");
		const again = accounts.setupAdmin({ name: "other", password: "password-2" });
		assert.equal(!again.ok && again.status, 409, "setup only while no account exists");
	});

	it("is refused without the accounts switch", () => {
		const result = accounts.setupAdmin({ name: "ada", password: "password-1" });
		assert.equal(!result.ok && result.code, "accounts_off");
	});
});

describe("request scoping with accounts", () => {
	const echo = scoped(async (_request: Request) => Response.json({ scope: activeDataScope() ?? null }), { project: "none" });
	const adminOnly = scoped(async (_request: Request) => Response.json({ ok: true }), { project: "none", admin: true });

	it("no session → 401; a session → that account's root", async () => {
		ON();
		const account = store.createAccount("jana", "password-1", false);
		const token = store.createSession(account.id);
		assert.equal((await echo(new Request("http://lh.test/api/x"))).status, 401);
		const body = (await (await echo(new Request("http://lh.test/api/x", { headers: cookie(token) }))).json()) as { scope: DataScope };
		assert.equal(body.scope.userId, account.id);
		assert.equal(body.scope.userRoot, store.accountRoot(account.id));
		assert.equal(body.scope.admin, false);
		assert.equal(sessionToken(new Request("http://lh.test", { headers: cookie(token) })), token);
	});

	it("admin-only routes answer 403 to everyone else", async () => {
		ON();
		const jana = store.createAccount("jana", "password-1", false);
		const boss = store.createAccount("boss", "password-1", true);
		assert.equal((await adminOnly(new Request("http://lh.test/api/keys", { headers: cookie(store.createSession(jana.id)) }))).status, 403);
		assert.equal((await adminOnly(new Request("http://lh.test/api/keys", { headers: cookie(store.createSession(boss.id)) }))).status, 200);
	});
});

describe("host file tools are the admin's", () => {
	const ctx = { chatId: "c1", deliver: () => {}, jobStore: { createJob: () => { throw new Error("unused"); } } as never, spawn: () => {}, chatStore: {} as never };
	it("non-admin agents get no read/ls/find/grep and no pdf job", () => {
		const user: DataScope = { userId: "usr_x", admin: false, userRoot: TMP_DATA };
		runInDataScope(user, () => {
			assert.equal(hostFileAccess(), false);
			for (const tools of [createTeacherTools(ctx), createProberTools(ctx)]) {
				for (const name of ["read", "ls", "find", "grep", "pdf"]) assert.equal(name in tools, false, name);
				assert.ok("research" in tools, "web research stays");
			}
		});
		runInDataScope({ ...user, admin: true }, () => {
			const tools = createTeacherTools(ctx);
			for (const name of ["read", "ls", "find", "grep", "pdf"]) assert.ok(name in tools, name);
		});
	});
});

describe("account management", () => {
	it("a new account starts with the admin's models and no projects; reset ends its sessions; no self-delete", () => {
		ON();
		const boss = store.createAccount("boss", "password-1", true);
		const bossScope = scopeFor(accountUser(boss));
		const models = { strong: { model: { provider: "anthropic", id: "claude-haiku-4-5" }, fallback: { model: { provider: "openrouter", id: "x/y" } } } };
		runInDataScope(bossScope, () => writeSettings({ version: 1, models, general: { autoUpdate: false } }));
		const created = runInDataScope(bossScope, () => accounts.createAccountAsAdmin({ name: "Jana", password: "password-2" }));
		assert.ok(created.ok);
		const jana = store.getAccount(created.account.id)!;
		assert.equal(jana.name, "jana");
		const janaSettings = runInDataScope(scopeFor(accountUser(jana)), () => readSettings());
		assert.deepEqual(janaSettings?.models, models, "slots and fallbacks copied");
		assert.equal(janaSettings?.general, undefined, "nothing else is copied");
		assert.deepEqual(listProjects(store.accountRoot(jana.id)), []);
		const dup = runInDataScope(bossScope, () => accounts.createAccountAsAdmin({ name: "jana", password: "password-2" }));
		assert.equal(!dup.ok && dup.status, 409);

		const token = store.createSession(jana.id);
		assert.ok(runInDataScope(bossScope, () => accounts.resetPasswordAsAdmin(jana.id, { password: "password-3" })).ok);
		assert.equal(store.sessionAccount(token), null, "the reset signs her out");
		assert.ok(store.verifyLogin("jana", "password-3"));

		const self = runInDataScope(bossScope, () => accounts.deleteAccountAsAdmin(boss.id));
		assert.equal(!self.ok && self.code, "own_account");
		assert.ok(runInDataScope(bossScope, () => accounts.deleteAccountAsAdmin(jana.id)).ok);
		assert.equal(store.getAccount(jana.id), null);
		assert.equal(fs.existsSync(store.accountRoot(jana.id)), false, "her data went with her");
	});

	it("changing your own password keeps this session and ends the others", () => {
		ON();
		const jana = store.createAccount("jana", "password-1", false);
		const here = store.createSession(jana.id);
		const there = store.createSession(jana.id);
		const request = new Request("http://lh.test/api/auth/password", { headers: cookie(here) });
		const scope = scopeFor(accountUser(jana));
		const wrong = runInDataScope(scope, () => accounts.changeOwnPassword(request, { current: "nope-nope", next: "password-2" }));
		assert.equal(!wrong.ok && wrong.code, "bad_current");
		assert.ok(runInDataScope(scope, () => accounts.changeOwnPassword(request, { current: "password-1", next: "password-2" })).ok);
		assert.ok(store.sessionAccount(here));
		assert.equal(store.sessionAccount(there), null);
	});

	it("a failed sign-in answers late and says nothing about which part was wrong", async () => {
		ON();
		store.createAccount("jana", "password-1", false);
		const started = Date.now();
		const result = await accounts.signIn({ name: "jana", password: "wrong-one" });
		assert.ok(Date.now() - started >= 700);
		assert.equal(!result.ok && result.error, "Wrong name or password.");
		const ok = await accounts.signIn({ name: "JANA", password: "password-1" });
		assert.ok(ok.ok && ok.token);
	});
});

describe("the sign-in gate (proxy)", () => {
	it("accounts mode: no cookie → pages go to /login, APIs answer 401; /login, /setup and /api/auth stay open", () => {
		ON();
		const page = proxy(new NextRequest("http://lh.test/p/prj_1"));
		assert.equal(page.status, 307);
		assert.equal(page.headers.get("location"), "http://lh.test/login");
		assert.equal(proxy(new NextRequest("http://lh.test/api/chats")).status, 401);
		for (const open of ["/login", "/setup", "/api/auth/login"]) {
			assert.equal(proxy(new NextRequest(`http://lh.test${open}`)).headers.get("x-middleware-next"), "1", open);
		}
		const withCookie = new NextRequest("http://lh.test/p/prj_1", { headers: { cookie: `${store.SESSION_COOKIE}=abc` } });
		assert.equal(proxy(withCookie).headers.get("x-middleware-next"), "1", "optimistic: the route verifies the session");
	});

	it("without accounts nothing is gated", () => {
		assert.equal(proxy(new NextRequest("http://lh.test/p/prj_1")).headers.get("x-middleware-next"), "1");
	});
});

describe("settings sections per viewer", () => {
	it("Providers is the admin's; Account for everyone with accounts; Accounts for the admin", () => {
		const local = { accounts: false, user: { id: "local", name: "local", admin: true } };
		const admin = { accounts: true, user: { id: "u1", name: "boss", admin: true } };
		const member = { accounts: true, user: { id: "u2", name: "jana", admin: false } };
		assert.deepEqual(accountSectionIds(local), []);
		assert.deepEqual(accountSectionIds(member), ["account"]);
		assert.deepEqual(accountSectionIds(admin), ["account", "accounts"]);
		assert.ok(visibleSectionIds(local).includes("keys"));
		assert.ok(!visibleSectionIds(local).includes("account"));
		assert.ok(!visibleSectionIds(member).includes("keys"));
		assert.ok(visibleSectionIds(member).includes("account"));
		assert.ok(visibleSectionIds(admin).includes("accounts"));
	});
});
