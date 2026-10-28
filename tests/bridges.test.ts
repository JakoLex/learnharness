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
import { anyInView, bridgeCurve, bundleBand, bundleBridges, distToPolyline, sampleQuad, worldView } from "../components/graph-canvas.ts";
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
			{
				id: "arg_br",
				kind: "bridge",
				premises: ["a1", "b1"],
				conclusion: "b2",
				from: ["a1"],
				source: "src_b",
				note: "a1 together with b1 gives b2.",
			},
		]);
	});

	it("draws an ordinary chain through another source's idea as a shared link, not as an argument", () => {
		const shared = {
			nodes: [node("a1", "src_a", "src_b"), node("b1", "src_b"), node("b2", "src_b"), node("b3", "src_b")],
			chains: [
				{ id: "arg_s", premises: ["a1", "b1"], conclusion: "b2", createdAt: "", provenance: [{ chatId: "src_b", messageId: "" }] },
				{ id: "arg_in", premises: ["b1", "b2"], conclusion: "b3", createdAt: "", provenance: [{ chatId: "src_b", messageId: "" }] },
			],
		} as unknown as DerivedGraph;
		const view = deriveView(shared);
		assert.deepEqual(view.bridges.map((b) => [b.id, b.kind, b.from]), [["arg_s", "shared", ["a1"]]]);
		assert.deepEqual(view.impLinks.map((l) => l.id), ["arg_in"]); // same-source chains still draw as arguments
		assert.ok(!view.nodes.some((n) => n.id === "arg_s"));
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

	it("maps the camera to the world rectangle it shows", () => {
		// Pan (100, 50), zoom 2, on an 800×600 canvas.
		assert.deepEqual(worldView({ x: 100, y: 50, k: 2 }, 800, 600), { minX: -50, minY: -25, maxX: 350, maxY: 275 });
	});

	it("a bridge is in view while ANY of its nodes is (a peeking disc counts)", () => {
		const view = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
		assert.equal(anyInView([{ x: -500, y: 50 }, { x: 50, y: 50 }], view), true, "one end on screen");
		assert.equal(anyInView([{ x: -500, y: 50 }, { x: 600, y: 50 }], view), false, "both ends off screen — it only crosses");
		assert.equal(anyInView([{ x: 104, y: 50 }], view, 5), true, "within a node radius of the edge");
		assert.equal(anyInView([{ x: 106, y: 50 }], view, 5), false);
	});

	it("measures the distance to a sampled curve", () => {
		const pts = sampleQuad({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, 10);
		assert.equal(pts.length, 11);
		assert.ok(Math.abs(distToPolyline({ x: 5, y: 3 }, pts) - 3) < 1e-9);
	});
});

describe("bundleBand (the zoomed-out shadow between two sources)", () => {
	const band = bundleBand({ x: 0, y: 0 }, { x: 100, y: 0 }, 20, 10, 9)!;

	it("flares into both clusters and narrows in the middle", () => {
		assert.equal(band.flareA, 14);
		assert.equal(band.flareB, 7);
		assert.ok(band.waist > 0 && band.waist < Math.min(band.flareA, band.flareB));
	});

	it("is one closed outline of four arcs", () => {
		assert.equal(band.arcs.length, 4);
		for (let i = 0; i < 4; i++) assert.deepEqual(band.arcs[i]![2], band.arcs[(i + 1) % 4]![0]);
	});

	it("passes through the waist at the middle of each flank", () => {
		const [p, c, q] = band.arcs[0]!;
		const midY = 0.25 * p.y + 0.5 * c.y + 0.25 * q.y;
		assert.ok(Math.abs(Math.abs(midY) - band.waist) < 1e-9);
	});

	it("narrows with scale and gives nothing for coincident centers", () => {
		assert.ok(bundleBand({ x: 0, y: 0 }, { x: 100, y: 0 }, 20, 10, 9, 0.5)!.flareA < band.flareA);
		assert.equal(bundleBand({ x: 1, y: 1 }, { x: 1, y: 1 }, 20, 10, 9), null);
	});
});
