/**
 * The bridger's deterministic gate (fork, 2026-10-27): validateBridges
 * decides which of the bridger's proposed cross-source chains reach the
 * merger. Pure over a derived graph — no engines, no ledgers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DerivedGraph } from "../src/core/graph.ts";
import { validateBridges, type BridgeProposal } from "../src/agent/subagents/extraction.ts";
import { deriveView, simplifyChains } from "../src/core/graph.ts";
import { bridgeCurve, bundleBridges, distToPolyline, sampleQuad } from "../components/graph-canvas.ts";
import { BRIDGE_ANCHOR } from "../src/core/contracts.ts";

// Two sources: A (functional analysis) and B (mechanics). Inside B,
// b1 ⇒ b2 already holds.
const node = (id: string, ...sources: string[]) => ({
	id,
	name: id,
	statement: id,
	aliases: [],
	createdAt: "2026-10-27T00:00:00.000Z",
	provenance: sources.map((chatId) => ({ chatId, messageId: "" })),
});
const graph = {
	nodes: [node("a1", "src_a"), node("a2", "src_a"), node("b1", "src_b"), node("b2", "src_b"), node("shared", "src_a", "src_b")],
	chains: [{ id: "arg_1", premises: ["b1"], conclusion: "b2", createdAt: "", provenance: [{ chatId: "src_b", messageId: "" }] }],
} as unknown as DerivedGraph;
const bridge = (premises: string[], conclusion: string): BridgeProposal => ({ premises, conclusion, reason: "test" });

describe("validateBridges", () => {
	it("accepts a chain from another source into this one", () => {
		const { accepted, rejected } = validateBridges(graph, "src_b", [bridge(["a1"], "b1")]);
		assert.deepEqual(accepted.map((b) => [b.premises, b.conclusion]), [[["a1"], "b1"]]);
		assert.deepEqual(rejected, []);
	});

	it("accepts the other direction too (this source derives another's idea)", () => {
		assert.equal(validateBridges(graph, "src_b", [bridge(["b2"], "a2")]).accepted.length, 1);
	});

	it("rejects chains that stay inside one source", () => {
		const { rejected } = validateBridges(graph, "src_b", [bridge(["b1"], "b2"), bridge(["a1"], "a2")]);
		assert.deepEqual(rejected.map((r) => r.why), ["does not cross sources", "does not cross sources"]);
	});

	it("rejects unknown ids and self-derivations", () => {
		const { rejected } = validateBridges(graph, "src_b", [bridge(["a9"], "b1"), bridge(["a1", "b1"], "b1")]);
		assert.deepEqual(rejected.map((r) => r.why), ["unknown id(s) a9", "conclusion among its premises"]);
	});

	it("rejects a bridge that closes a cycle over existing chains", () => {
		// b1 ⇒ b2 exists; b2 ⇒ a1 ⇒ b1 would close b1 → b2 → a1 → b1.
		const { accepted, rejected } = validateBridges(graph, "src_b", [bridge(["b2"], "a1"), bridge(["a1"], "b1")]);
		assert.equal(accepted.length, 1);
		assert.deepEqual(rejected.map((r) => r.why), ["would close a cycle"]);
	});

	it("counts a node by its birth source, not by sources that merely linked it", () => {
		// "shared" was born in src_a and linked by src_b: a chain between it and
		// a1 is src_a-internal, from src_b's point of view no bridge.
		const { rejected } = validateBridges(graph, "src_b", [bridge(["shared"], "a2")]);
		assert.deepEqual(rejected.map((r) => r.why), ["does not cross sources"]);
		assert.equal(validateBridges(graph, "src_b", [bridge(["shared"], "b1")]).accepted.length, 1);
	});

	it("dedupes repeated premises", () => {
		assert.deepEqual(validateBridges(graph, "src_b", [bridge(["a1", "a1"], "b1")]).accepted[0]!.premises, ["a1"]);
	});
});

describe("simplifyChains and bridge chains", () => {
	const line = (id: string, premises: string[], conclusion: string, messageId = "") => ({
		id,
		premises,
		conclusion,
		createdAt: `2026-10-27T00:00:0${id.length}.000Z`,
		provenance: [{ chatId: "src_b", messageId }],
	});

	it("drops a superset derivation from the same source (upstream rule 1)", () => {
		const kept = simplifyChains([line("arg_1", ["b1"], "b2"), line("arg_22", ["b1", "a1"], "b2")]);
		assert.deepEqual(kept.map((l) => l.id), ["arg_1"]);
	});

	it("keeps a bridge that adds the other source's premise", () => {
		const kept = simplifyChains([line("arg_1", ["b1"], "b2"), line("arg_22", ["b1", "a1"], "b2", BRIDGE_ANCHOR)]);
		assert.deepEqual(kept.map((l) => l.id), ["arg_1", "arg_22"]);
	});
});

describe("deriveView and bridges (drawn apart from the arguments)", () => {
	const g = {
		nodes: [node("a1", "src_a"), node("b1", "src_b"), node("b2", "src_b")],
		chains: [
			{
				id: "arg_br",
				premises: ["a1", "b1"],
				conclusion: "b2",
				createdAt: "",
				provenance: [{ chatId: "src_b", messageId: BRIDGE_ANCHOR }],
				note: "a1 together with b1 gives b2.",
			},
		],
	} as unknown as DerivedGraph;

	it("draws no implication node and no edges for a bridge", () => {
		const view = deriveView(g);
		assert.ok(!view.nodes.some((n) => n.id === "arg_br"));
		assert.deepEqual(view.edges, []);
		assert.deepEqual(view.impLinks, []);
	});

	it("hands the canvas the foreign premise only, with the note", () => {
		assert.deepEqual(deriveView(g).bridges, [
			{ id: "arg_br", premises: ["a1", "b1"], conclusion: "b2", from: ["a1"], note: "a1 together with b1 gives b2." },
		]);
	});

	it("keeps every premise in the logical edges", () => {
		assert.deepEqual(deriveView(g).logicalEdges, [
			{ from: "a1", to: "b2" },
			{ from: "b1", to: "b2" },
		]);
	});
});

describe("bridge canvas helpers", () => {
	it("bundles bridges per unordered pair of clusters", () => {
		const cluster: Record<string, string> = { a1: "A", a2: "A", b1: "B", b2: "B" };
		const bundles = bundleBridges(
			[
				{ from: ["a1"], to: "b1" },
				{ from: ["b2"], to: "a2" },
				{ from: ["a1"], to: "a2" },
				{ from: ["x"], to: "b1" },
			],
			(id) => cluster[id],
		);
		assert.deepEqual(bundles, [{ a: "A", b: "B", count: 2 }]);
	});

	it("bends a curve to the left of its chord and stops at the discs", () => {
		const c = bridgeCurve({ x: 0, y: 0 }, { x: 10, y: 0 }, 1, 1, 2)!;
		assert.ok(c.ctrl.y > 0, "control point to the left of a→b (y down)");
		assert.ok(Math.abs(Math.hypot(c.start.x, c.start.y) - 1) < 1e-9);
		assert.ok(Math.abs(Math.hypot(c.head.tip.x - 10, c.head.tip.y) - 1) < 1e-9);
		assert.equal(bridgeCurve({ x: 1, y: 1 }, { x: 1, y: 1 }, 1, 1, 2), null);
	});

	it("measures the distance to a sampled curve", () => {
		const pts = sampleQuad({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, 10);
		assert.equal(pts.length, 11);
		assert.ok(Math.abs(distToPolyline({ x: 5, y: 3 }, pts) - 3) < 1e-9);
	});
});
