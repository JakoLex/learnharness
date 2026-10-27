/**
 * The randomUUID polyfill (fork, 2026-10-27): plain-http LAN access has no
 * crypto.randomUUID; the inline <head> script adds one on top of
 * getRandomValues and never replaces a native implementation.
 */

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";
import vm from "node:vm";
import { RANDOM_UUID_POLYFILL } from "../app/random-uuid-polyfill.ts";

const run = (crypto: object) => {
	const sandbox = { globalThis: undefined as unknown, crypto, Array, Uint8Array };
	sandbox.globalThis = sandbox;
	vm.runInNewContext(RANDOM_UUID_POLYFILL, sandbox);
	return crypto as { randomUUID?: () => string };
};

describe("randomUUID polyfill", () => {
	it("adds an RFC 4122 v4 randomUUID where only getRandomValues exists", () => {
		const c = run({ getRandomValues: (a: Uint8Array) => webcrypto.getRandomValues(a) });
		assert.equal(typeof c.randomUUID, "function");
		const ids = new Set(Array.from({ length: 50 }, () => c.randomUUID!()));
		assert.equal(ids.size, 50);
		for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("keeps a native randomUUID", () => {
		const native = () => "native";
		assert.equal(run({ randomUUID: native, getRandomValues: () => undefined }).randomUUID, native);
	});
});
