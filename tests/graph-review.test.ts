/**
 * The graph review's ledger operations (fork, owner 2026-11-10):
 * merge (older id survives, chosen text, phrasings + provenance + chains
 * travel), correct (old text discarded), chain repair/delete, and the
 * backup/restore pair behind undo.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode, Position } from "../src/core/contracts.ts";
import { getGraph } from "../src/core/graph.ts";
import {
	correctNode,
	deleteChain,
	mergeNodes,
	repairChain,
	restoreReviewBackup,
	reviewFingerprintInput,
	snapshotForReview,
} from "../src/core/graph-review.ts";
import type { GraphStore } from "../src/core/ports.ts";

function memoryStore(nodes: GraphNode[], chains: GraphChain[], positions: Record<string, Position> = {}) {
	const state = { nodes: [...nodes], chains: [...chains], positions: { ...positions } };
	const store = {
		readNodes: () => state.nodes.map((n) => ({ ...n, aliases: [...n.aliases], provenance: [...n.provenance] })),
		readChains: () => state.chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })),
		readPositions: () => ({ ...state.positions }),
		writePositions: (p: Record<string, Position>) => void (state.positions = { ...p }),
		rewriteLedgers: (next: { nodes?: GraphNode[]; chains?: GraphChain[] }) => {
			if (next.nodes) state.nodes = next.nodes;
			if (next.chains) state.chains = next.chains;
		},
	} as unknown as GraphStore;
	return { store, state };
}

const node = (id: string, statement: string, source: string, aliases: string[] = []): GraphNode => ({
	id,
	name: id.toUpperCase(),
	statement,
	aliases,
	createdAt: "2026-11-10T00:00:00.000Z",
	provenance: [{ chatId: source, messageId: "" }],
});
const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id,
	premises,
	conclusion,
	provenance: [{ chatId: "src_a", messageId: "" }],
	createdAt: "2026-11-10T00:00:00.000Z",
});

describe("mergeNodes", () => {
	it("keeps the OLDER id, takes the chosen text, and moves phrasings, provenance and chains", () => {
		const { store, state } = memoryStore(
			[node("n_old", "old wording", "src_a", ["old alias"]), node("n_x", "x", "src_a"), node("n_new", "new wording", "src_b", ["new alias"])],
			[chain("arg_1", ["n_new"], "n_x"), chain("arg_2", ["n_x"], "n_new")],
			{ n_old: { x: 0, y: 0 }, n_new: { x: 5, y: 5 }, n_x: { x: 1, y: 1 } },
		);
		// Argument order must not matter: the older node survives.
		const result = mergeNodes(store, { ids: ["n_new", "n_old"], name: "Chosen", statement: "new wording" });
		assert.deepEqual(result, { survivor: "n_old", removed: "n_new", chainsRewired: 2, chainsDropped: 0 });
		const merged = getGraph(store).nodes.find((n) => n.id === "n_old")!;
		assert.equal(merged.name, "Chosen");
		assert.equal(merged.statement, "new wording");
		assert.ok(merged.aliases.includes("old wording"), "the survivor's former statement stays as a phrasing");
		assert.ok(merged.aliases.includes("new alias") && merged.aliases.includes("old alias"));
		assert.deepEqual(merged.provenance.map((p) => p.chatId).sort(), ["src_a", "src_b"]);
		assert.ok(!getGraph(store).nodes.some((n) => n.id === "n_new"));
		assert.deepEqual(state.chains.map((c) => [c.premises, c.conclusion]), [[["n_old"], "n_x"], [["n_x"], "n_old"]]);
		assert.equal(state.positions.n_new, undefined);
		assert.deepEqual(state.positions.n_old, { x: 0, y: 0 });
	});

	it("drops a chain that collapses onto itself and dedupes premises", () => {
		const { store, state } = memoryStore(
			[node("a", "a", "s"), node("b", "b", "s"), node("c", "c", "s")],
			[chain("arg_ab", ["a"], "b"), chain("arg_abc", ["a", "b"], "c")],
		);
		const result = mergeNodes(store, { ids: ["a", "b"], name: "A", statement: "a" })!;
		assert.equal(result.chainsDropped, 1);
		assert.deepEqual(state.chains.map((c) => [c.id, c.premises, c.conclusion]), [["arg_abc", ["a"], "c"]]);
	});

	it("gives a chain that now equals another one that chain's id (one id per argument)", () => {
		const { store, state } = memoryStore(
			[node("a", "a", "s"), node("b", "b", "s"), node("c", "c", "s")],
			[chain("arg_ac", ["a"], "c"), chain("arg_bc", ["b"], "c")],
		);
		mergeNodes(store, { ids: ["a", "b"], name: "A", statement: "a" });
		assert.deepEqual(state.chains.map((c) => c.id), ["arg_ac", "arg_ac"]);
		assert.equal(deleteChain(store, "arg_ac"), true);
		assert.equal(getGraph(store).chains.length, 0, "deleting by id removes every line of the argument");
	});

	it("refuses unknown ids, identical ids and empty text", () => {
		const { store } = memoryStore([node("a", "a", "s"), node("b", "b", "s")], []);
		assert.equal(mergeNodes(store, { ids: ["a", "zz"], name: "A", statement: "a" }), null);
		assert.equal(mergeNodes(store, { ids: ["a", "a"], name: "A", statement: "a" }), null);
		assert.equal(mergeNodes(store, { ids: ["a", "b"], name: "A", statement: "  " }), null);
	});
});

describe("correctNode", () => {
	it("replaces the create line's text and discards the old version", () => {
		const { store, state } = memoryStore([node("a", "wrong ‖x‖_S", "s", ["wrong ‖x‖_S", "other"]), { ...node("a", "a later phrasing", "t") }], []);
		const before = correctNode(store, { id: "a", statement: "right ‖x‖_H" });
		assert.deepEqual(before, { name: "A", statement: "wrong ‖x‖_S" });
		assert.equal(state.nodes[0]!.statement, "right ‖x‖_H");
		assert.deepEqual(state.nodes[0]!.aliases, ["other"]);
		assert.equal(state.nodes[1]!.statement, "a later phrasing", "link lines keep their own phrasing");
		assert.equal(getGraph(store).nodes[0]!.statement, "right ‖x‖_H");
	});
	it("is null for unknown ids and no-op changes", () => {
		const { store } = memoryStore([node("a", "a", "s")], []);
		assert.equal(correctNode(store, { id: "zz", statement: "x" }), null);
		assert.equal(correctNode(store, { id: "a", statement: "a" }), null);
	});
});

describe("repairChain / deleteChain", () => {
	it("repairs with existing nodes only, never the conclusion itself", () => {
		const { store, state } = memoryStore([node("a", "a", "s"), node("b", "b", "s"), node("c", "c", "s")], [chain("arg_1", ["a"], "c")]);
		assert.equal(repairChain(store, { chainId: "arg_1", premises: ["zz"] }), null);
		assert.equal(repairChain(store, { chainId: "arg_1", premises: ["c"] }), null);
		assert.deepEqual(repairChain(store, { chainId: "arg_1", premises: ["a", "b", "a"] }), ["a"]);
		assert.deepEqual(state.chains[0]!.premises, ["a", "b"]);
	});
	it("deletes a chain's lines and nothing else", () => {
		const { store, state } = memoryStore([node("a", "a", "s"), node("c", "c", "s")], [chain("arg_1", ["a"], "c")], { arg_1: { x: 1, y: 1 } });
		assert.equal(deleteChain(store, "arg_1"), true);
		assert.equal(state.chains.length, 0);
		assert.equal(state.nodes.length, 2);
		assert.equal(state.positions.arg_1, undefined);
		assert.equal(deleteChain(store, "a"), false, "only arg_ ids name chains");
	});
});

describe("review backup", () => {
	it("restores nodes, chains and positions exactly; the fingerprint tracks ledger changes only", () => {
		const { store, state } = memoryStore([node("a", "a", "s"), node("b", "b", "s")], [chain("arg_1", ["a"], "b")], { a: { x: 1, y: 2 } });
		const backup = snapshotForReview(store);
		const before = reviewFingerprintInput(store);
		mergeNodes(store, { ids: ["a", "b"], name: "A", statement: "a" });
		const after = reviewFingerprintInput(store);
		assert.notEqual(before, after);
		state.positions = { a: { x: 9, y: 9 } };
		assert.equal(reviewFingerprintInput(store), after, "a layout commit does not block undo");
		restoreReviewBackup(store, backup);
		assert.equal(reviewFingerprintInput(store), before);
		assert.deepEqual(state.positions, { a: { x: 1, y: 2 } });
	});
});
