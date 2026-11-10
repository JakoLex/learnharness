/**
 * The background relax (fork, owner 2026-11-10): the worker runs the live
 * sim's own force set to rest, so the canvas can glide straight to the
 * result instead of drawing every anneal frame.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bboxCenter, liveSimOptions, maxDisplacement, relaxPositions, type RelaxData } from "../src/core/relax.ts";
import { DEFAULT_PHYSICS_TUNING } from "../src/core/render-settings.ts";

const data: RelaxData = {
	nodes: [
		{ id: "a", x: 0, y: 0 },
		{ id: "b", x: 30, y: 10 },
		{ id: "c", x: 900, y: -400 },
		{ id: "d", x: -700, y: 600 },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
		{ from: "c", to: "d" },
	],
	clusters: [{ members: ["a", "b"] }, { members: ["c", "d"] }],
};

describe("relaxPositions", () => {
	it("is deterministic and covers every node with finite coordinates", () => {
		const center = bboxCenter(data.nodes);
		const first = relaxPositions(data, DEFAULT_PHYSICS_TUNING, center);
		const second = relaxPositions(data, DEFAULT_PHYSICS_TUNING, center);
		assert.deepEqual(first, second);
		assert.deepEqual(Object.keys(first).sort(), ["a", "b", "c", "d"]);
		for (const p of Object.values(first)) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
	});

	it("comes to rest: relaxing the result again moves far less than the first relax", () => {
		const firstOut = relaxPositions(data, DEFAULT_PHYSICS_TUNING, bboxCenter(data.nodes));
		const firstMove = maxDisplacement(data.nodes, firstOut)!;
		const settled = { ...data, nodes: data.nodes.map((n) => ({ id: n.id, ...firstOut[n.id]! })) };
		const secondMove = maxDisplacement(settled.nodes, relaxPositions(settled, DEFAULT_PHYSICS_TUNING, bboxCenter(settled.nodes)))!;
		assert.ok(firstMove > 100, `the scattered graph should move (moved ${firstMove.toFixed(0)})`);
		assert.ok(secondMove < firstMove / 5, `second relax moved ${secondMove.toFixed(1)}, first ${firstMove.toFixed(1)}`);
	});
});

describe("maxDisplacement", () => {
	it("is null when the answer misses a node (computed for another node set)", () => {
		assert.equal(maxDisplacement(data.nodes, { a: { x: 0, y: 0 } }), null);
	});
	it("is the largest single move", () => {
		const moved = Object.fromEntries(data.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
		moved.c = { x: 900 + 30, y: -400 + 40 };
		assert.equal(maxDisplacement(data.nodes, moved), 50);
	});
});

describe("liveSimOptions", () => {
	it("maps the tuning onto the live sim's forces (depth anchor only when on)", () => {
		const center = { x: 1, y: 2 };
		const off = liveSimOptions(data, { ...DEFAULT_PHYSICS_TUNING, depthMode: "off" }, center);
		assert.equal(off.depthAnchor, undefined);
		assert.deepEqual(off.gravity, { x: 1, y: 2, strength: DEFAULT_PHYSICS_TUNING.gravity });
		const on = liveSimOptions(data, { ...DEFAULT_PHYSICS_TUNING, depthMode: "vertical" }, center);
		assert.equal(on.depthAnchor?.mode, "vertical");
		assert.deepEqual(on.depthAnchor?.center, center);
	});
});
