/**
 * The fork's switches (src/server/fork-features.ts, owner 2026-10-29): the
 * custom endpoint and Claude Code stay off unless LH_CUSTOM_ENDPOINT=1 /
 * LH_CLAUDE_CODE=1; NODE_ENV=test alone keeps upstream's tests running them.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-fork-features-"));
process.env.LH_DATA_DIR = testData;
process.env.LH_AUTH_FILE = join(testData, "auth.json");
const { claudeCodeFeature, customEndpointFeature, forkFeatureFlags } = await import("../src/server/fork-features.ts");
const { claudeCodeEnabled } = await import("../src/server/claude-code-config.ts");
const { writeSettings, readSettings } = await import("../src/store/settings.ts");
const customRoute = await import("../app/api/custom-provider/route.ts");
const keysRoute = await import("../app/api/keys/route.ts");

const env = process.env as Record<string, string | undefined>; // NODE_ENV is typed read-only
const saved = { custom: env.LH_CUSTOM_ENDPOINT, claude: env.LH_CLAUDE_CODE, node: env.NODE_ENV, accounts: env.LH_ACCOUNTS };
function restore(name: string, value: string | undefined) {
	if (value === undefined) delete env[name];
	else env[name] = value;
}
afterEach(() => {
	restore("LH_CUSTOM_ENDPOINT", saved.custom);
	restore("LH_CLAUDE_CODE", saved.claude);
	restore("NODE_ENV", saved.node);
	restore("LH_ACCOUNTS", saved.accounts);
});
after(() => rmSync(testData, { recursive: true, force: true }));

test("unset outside tests means off; =1 turns a feature on", () => {
	delete process.env.LH_CUSTOM_ENDPOINT;
	delete process.env.LH_CLAUDE_CODE;
	env.NODE_ENV = "production";
	assert.deepEqual(forkFeatureFlags(), { customEndpoint: false, claudeCode: false });
	process.env.LH_CUSTOM_ENDPOINT = "1";
	process.env.LH_CLAUDE_CODE = "1";
	assert.equal(customEndpointFeature(), true);
	assert.equal(claudeCodeFeature(), true);
});

test("under NODE_ENV=test both default on, and =0 still turns them off", () => {
	env.NODE_ENV = "test";
	delete process.env.LH_CUSTOM_ENDPOINT;
	delete process.env.LH_CLAUDE_CODE;
	assert.deepEqual(forkFeatureFlags(), { customEndpoint: true, claudeCode: true });
	process.env.LH_CUSTOM_ENDPOINT = "0";
	process.env.LH_CLAUDE_CODE = "0";
	assert.deepEqual(forkFeatureFlags(), { customEndpoint: false, claudeCode: false });
});

test("the custom endpoint never runs with accounts on", () => {
	env.LH_CUSTOM_ENDPOINT = "1";
	env.LH_ACCOUNTS = "1";
	assert.equal(customEndpointFeature(), false);
	delete env.LH_ACCOUNTS;
	assert.equal(customEndpointFeature(), true);
});

test("Claude Code stays off even with the opt-in saved", () => {
	writeSettings({ ...(readSettings() ?? { version: 1 }), claudeCode: { enabled: true } });
	process.env.LH_CLAUDE_CODE = "1";
	assert.equal(claudeCodeEnabled(), true);
	process.env.LH_CLAUDE_CODE = "0";
	assert.equal(claudeCodeEnabled(), false);
});

test("the custom endpoint routes answer 404 while it is off", async () => {
	process.env.LH_CUSTOM_ENDPOINT = "0";
	const get = customRoute.GET(new Request("http://localhost/api/custom-provider"));
	assert.equal(get.status, 404);
	const post = await customRoute.POST(new Request("http://localhost/api/custom-provider", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "http://example.invalid/v1" }),
	}));
	assert.equal(post.status, 404);
});

test("GET /api/keys tells the settings UI what it may offer", async () => {
	process.env.LH_CUSTOM_ENDPOINT = "0";
	process.env.LH_CLAUDE_CODE = "0";
	const body = await (await keysRoute.GET()).json() as { features?: unknown };
	assert.deepEqual(body.features, { customEndpoint: false, claudeCode: false });
});
