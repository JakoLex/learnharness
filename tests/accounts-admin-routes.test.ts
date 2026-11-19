/**
 * Fork (upstream 0.6 merge, owner-approved 2026-11-19): with accounts on,
 * managing plugins and the shared themes is the admin's — the same scoped()
 * admin gate as Providers — and the streamed plugin document route, which
 * skips the Proxy, still needs a session. Owns its temp data dir and auth
 * file (set before any config-loading import).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-admin-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");

const store = await import("../src/store/accounts.ts");
const { THEMES_DIR } = await import("../config.ts");
const { DEFAULT_THEME } = await import("../src/core/themes.ts");
const themes = await import("../app/api/themes/route.ts");
const themeById = await import("../app/api/themes/[id]/route.ts");
const plugins = await import("../app/api/plugins/route.ts");
const pluginById = await import("../app/api/plugins/[id]/route.ts");
const documents = await import("../app/api/plugins/[id]/documents/markdown/route.ts");

const ENV_KEYS = ["LH_ACCOUNTS", "LH_DESKTOP_SERVER", "LH_DESKTOP_API_SECRET", "LH_ALLOWED_HOSTS"] as const;
const savedEnv = ENV_KEYS.map((key) => process.env[key]);
for (const key of ENV_KEYS) delete process.env[key];
afterEach(() => {
	delete process.env.LH_ACCOUNTS;
	for (const entry of fs.readdirSync(TMP_DATA)) fs.rmSync(path.join(TMP_DATA, entry), { recursive: true, force: true });
});
after(() => {
	ENV_KEYS.forEach((key, index) => { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; });
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const ORIGIN = "http://localhost";
const headersFor = (token?: string): Record<string, string> =>
	token ? { cookie: `${store.SESSION_COOKIE}=${encodeURIComponent(token)}` } : {};
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const themeImport = (token?: string) => new Request(`${ORIGIN}/api/themes`, {
	method: "POST", headers: { ...headersFor(token), "content-type": "application/json" },
	body: JSON.stringify({ name: "Shared Ayu", mode: DEFAULT_THEME.mode, colors: DEFAULT_THEME.colors }),
});

function people() {
	process.env.LH_ACCOUNTS = "1";
	const member = store.createAccount("jana", "password-1", false);
	const admin = store.createAccount("boss", "password-1", true);
	return { member: store.createSession(member.id), admin: store.createSession(admin.id) };
}

describe("themes are shared; only the admin adds or removes them", () => {
	it("a member reads the catalog but cannot import or delete (403); the admin can", async () => {
		const { member, admin } = people();
		assert.equal((await themes.GET(new Request(`${ORIGIN}/api/themes`, { headers: headersFor(member) }))).status, 200);
		assert.equal((await themes.POST(themeImport(member))).status, 403);
		assert.equal(fs.existsSync(THEMES_DIR) && fs.readdirSync(THEMES_DIR).length > 0, false, "nothing written for a member");
		const created = await themes.POST(themeImport(admin));
		assert.equal(created.status, 201);
		const { theme } = (await created.json()) as { theme: { id: string } };
		const remove = (token: string) => themeById.DELETE(new Request(`${ORIGIN}/api/themes/${theme.id}`, { method: "DELETE", headers: headersFor(token) }), params({ id: theme.id }));
		assert.equal((await remove(member)).status, 403);
		assert.equal((await remove(admin)).status, 200);
	});

	it("signed out → 401", async () => {
		people();
		assert.equal((await themes.POST(themeImport())).status, 401);
	});
});

describe("plugin management is the admin's", () => {
	it("refresh and enable/disable answer 403 to a member and 401 when signed out", async () => {
		const { member } = people();
		const refresh = (token?: string) => plugins.POST(new Request(`${ORIGIN}/api/plugins`, {
			method: "POST", headers: { ...headersFor(token), "content-type": "application/json" }, body: JSON.stringify({ action: "refresh" }),
		}));
		const toggle = (token?: string) => pluginById.PUT(new Request(`${ORIGIN}/api/plugins/fixture`, {
			method: "PUT", headers: { ...headersFor(token), "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
		}), params({ id: "fixture" }));
		assert.equal((await refresh(member)).status, 403);
		assert.equal((await toggle(member)).status, 403);
		assert.equal((await refresh()).status, 401);
		assert.equal((await toggle()).status, 401);
	});

	it("the document route skips the Proxy but still needs a session", async () => {
		people();
		const response = await documents.POST(new Request(`${ORIGIN}/api/plugins/fixture/documents/markdown`, { method: "POST" }), params({ id: "fixture" }));
		assert.equal(response.status, 401);
	});
});
