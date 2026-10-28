import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, normalizeContext, type StreamFunction } from "@earendil-works/pi-ai";
import {
	busyFromSnapshot,
	inflightSnapshot,
	llamaSwapBusy,
	llamaSwapOverflowSetup,
	type BusyVerdict,
} from "../src/agent/llama-swap-busy.ts";
import { clearModelOutages, modelOutages, withModelFallback } from "../src/agent/model-fallback.ts";
import { modelFallbackOf } from "../src/core/model-fallback.ts";

// The busy overflow (overflow wave, owner-approved 2026-10-28): a
// llama-swap primary asks whether the GPU is taken — the owner's OWUI
// gpu_overflow rule — waits up to 15 s, then leaves for the slot's
// fallback for the rest of the turn.

const PARALLEL = "ninfer/qwen3.8:27b-3090-rk8v4@256k";
const STRATA = "strata/qwen3.8-flash-next:125b-iq3_s@128k";
const rules = { cpuModels: new Set(["bge:m3-q6_k@8k", "doc-loader"]), parallelModels: new Set([PARALLEL]) };

describe("the busy rule (OWUI gpu_overflow _busy)", () => {
	it("free without GPU requests; CPU models never count", () => {
		assert.deepEqual(busyFromSnapshot([], STRATA, rules), { busy: false });
		assert.deepEqual(busyFromSnapshot([{ model: "bge:m3-q6_k@8k" }, { model: "doc-loader" }], STRATA, rules), { busy: false });
	});
	it("any GPU request makes it busy, naming what runs", () => {
		assert.deepEqual(busyFromSnapshot([{ model: STRATA }], STRATA, rules), { busy: true, reason: `GPU busy (${STRATA})` });
		assert.equal(busyFromSnapshot([{ model: PARALLEL }], STRATA, rules).busy, true);
	});
	it("a parallel model stays free while only it runs", () => {
		assert.equal(busyFromSnapshot([{ model: PARALLEL }], PARALLEL, rules).busy, false);
		assert.equal(busyFromSnapshot([{ model: PARALLEL }, { model: STRATA }], PARALLEL, rules).busy, true);
	});
	it("env lists and the events URL", () => {
		const setup = llamaSwapOverflowSetup("http://gpu.test:8080/v1", {
			LH_LLAMA_SWAP_CPU_MODELS: "bge:m3-q6_k@8k, doc-loader",
			LH_LLAMA_SWAP_PARALLEL_MODELS: PARALLEL,
		});
		assert.equal(setup.eventsUrl, "http://gpu.test:8080/api/events");
		assert.deepEqual([...setup.rules.cpuModels], ["bge:m3-q6_k@8k", "doc-loader"]);
		assert.deepEqual([...setup.rules.parallelModels], [PARALLEL]);
	});
});

/** A fake llama-swap /api/events: modelStatus first, then the snapshot. */
async function fakeSwap(frames: string[], hold = false): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		for (const frame of frames) res.write(`event: message\ndata: ${frame}\n\n`);
		if (!hold) res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/api/events`,
		close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
	};
}

describe("reading llama-swap's in-flight snapshot", () => {
	it("skips other events and returns the snapshot's requests", async () => {
		const swap = await fakeSwap([
			JSON.stringify({ type: "modelStatus", data: [{ id: STRATA, state: "ready" }] }),
			JSON.stringify({ type: "inflight", data: { operation: "snapshot", requests: [{ id: "906", model: STRATA, elapsed_ms: 8826 }] } }),
		], true);
		try {
			const requests = await inflightSnapshot(swap.url, 2000);
			assert.deepEqual(requests.map((r) => r.model), [STRATA]);
		} finally {
			await swap.close();
		}
	});
	it("accepts the payload as a JSON string too", async () => {
		const swap = await fakeSwap([JSON.stringify({ type: "inflight", data: JSON.stringify({ operation: "snapshot", requests: [] }) })], true);
		try {
			assert.deepEqual(await inflightSnapshot(swap.url, 2000), []);
		} finally {
			await swap.close();
		}
	});
	it("no snapshot within the budget, or nobody home → busy (unreachable)", async () => {
		const silent = await fakeSwap([], true);
		try {
			const started = Date.now();
			const verdict = await llamaSwapBusy(STRATA, { eventsUrl: silent.url, rules });
			assert.equal(verdict.busy, true);
			assert.equal(verdict.unreachable, true);
			assert.ok(Date.now() - started < 4000);
		} finally {
			await silent.close();
		}
		const closed = await llamaSwapBusy(STRATA, { eventsUrl: "http://127.0.0.1:9/api/events", rules });
		assert.deepEqual(closed, { busy: true, unreachable: true, reason: "GPU host unreachable" });
	});
});

describe("the overflow in the fallback stream", () => {
	afterEach(() => clearModelOutages());
	const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

	function engine(verdicts: BusyVerdict[], waitMs = 200) {
		const primary = createFauxCore({ provider: "llama-swap", models: [{ id: "big" }] });
		primary.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("from the GPU")));
		const backup = createFauxCore({ provider: "slopgate", models: [{ id: "small" }] });
		backup.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("from the fallback")));
		let checks = 0;
		let primaryCalls = 0;
		const primaryStream: StreamFunction = (m, c, o) => {
			primaryCalls++;
			return primary.streamSimple(m, c, o);
		};
		const streamFn = withModelFallback(
			{
				key: "llama-swap:big",
				stream: primaryStream,
				overflow: { check: async () => verdicts[Math.min(checks++, verdicts.length - 1)]!, waitMs, pollMs: 20 },
			},
			{ key: "slopgate:small", model: backup.getModel(), stream: backup.streamSimple },
		);
		const call = async () => (await streamFn(primary.getModel(), context, {})).result();
		return { call, checks: () => checks, primaryCalls: () => primaryCalls };
	}

	it("a free GPU answers; one check", async () => {
		const e = engine([{ busy: false }]);
		const result = await e.call();
		assert.equal(result.provider, "llama-swap");
		assert.equal(e.checks(), 1);
	});

	it("waits while busy and stays on the GPU when it frees up in time", async () => {
		const e = engine([{ busy: true, reason: "GPU busy (x)" }, { busy: true, reason: "GPU busy (x)" }, { busy: false }]);
		const result = await e.call();
		assert.equal(result.provider, "llama-swap");
		assert.equal(e.checks(), 3);
	});

	it("still busy after the wait → the fallback answers, noted as busy, no outage; the rest of the turn stays there", async () => {
		const e = engine([{ busy: true, reason: "GPU busy (strata)" }], 100);
		const first = await e.call();
		assert.equal(first.provider, "slopgate");
		assert.deepEqual(modelFallbackOf(first), { from: "llama-swap:big", to: "slopgate:small", reason: "GPU busy (strata)", skipped: true, busy: true });
		assert.deepEqual(modelOutages(), [], "busy is not an outage");
		const checksAfterFirst = e.checks();
		const second = await e.call();
		assert.equal(second.provider, "slopgate", "the next tool round stays on the fallback");
		assert.equal(e.checks(), checksAfterFirst, "no new check, no new wait");
		assert.equal(e.primaryCalls(), 0);
	});

	it("an unreachable GPU host is left at once and marked down", async () => {
		const e = engine([{ busy: true, unreachable: true, reason: "GPU host unreachable" }], 5000);
		const started = Date.now();
		const result = await e.call();
		assert.ok(Date.now() - started < 1000, "no waiting on a dead host");
		assert.equal(result.provider, "slopgate");
		assert.equal(modelFallbackOf(result)?.busy, undefined, "unavailable, not busy");
		assert.deepEqual(modelOutages().map((o) => o.model), ["llama-swap:big"]);
	});

	it("a new turn (a new engine) asks again", async () => {
		const busyTurn = engine([{ busy: true, reason: "GPU busy (x)" }], 50);
		assert.equal((await busyTurn.call()).provider, "slopgate");
		const nextTurn = engine([{ busy: false }]);
		assert.equal((await nextTurn.call()).provider, "llama-swap");
	});
});
