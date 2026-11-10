/**
 * The graph review's submit-seam checks (fork, owner 2026-11-10): a model
 * verdict is refused (and retried) before it can touch a ledger.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkChainVerdicts, checkCorrections, checkMerges, duplicatePrompt, type ReviewRecord } from "../src/agent/subagents/review.ts";

const rec = (id: string, name: string, statement: string): ReviewRecord => ({ id, name, statement });
const a = rec("a", "A", "statement a");
const b = rec("b", "B", "statement b");
const c = rec("c", "C", "statement c");
const shown = new Map([a, b, c].map((r) => [r.id, r]));
const pairs = new Set([["a", "b"].sort().join("\u0000")]);

describe("checkMerges", () => {
	it("accepts a shown pair keeping one record's name and statement verbatim", () => {
		assert.equal(checkMerges([{ ids: ["a", "b"], name: "B", statement: "statement b", reason: "same" }], shown, pairs), null);
	});
	it("refuses new text, mixed text, unshown pairs and reused ids", () => {
		assert.match(checkMerges([{ ids: ["a", "b"], name: "A", statement: "a rewritten", reason: "" }], shown, pairs)!, /verbatim/);
		assert.match(checkMerges([{ ids: ["a", "b"], name: "A", statement: "statement b", reason: "" }], shown, pairs)!, /verbatim/);
		assert.match(checkMerges([{ ids: ["a", "c"], name: "A", statement: "statement a", reason: "" }], shown, pairs)!, /not shown/);
		const both = new Set([...pairs, ["a", "c"].sort().join("\u0000")]);
		assert.match(
			checkMerges([
				{ ids: ["a", "b"], name: "A", statement: "statement a", reason: "" },
				{ ids: ["a", "c"], name: "A", statement: "statement a", reason: "" },
			], shown, both)!,
			/more than one merge/,
		);
		assert.match(checkMerges([{ ids: ["a", "zz"], name: "A", statement: "statement a", reason: "" }], shown, pairs)!, /Unknown/);
	});
});

describe("checkCorrections", () => {
	const ids = new Set(["a", "b"]);
	it("accepts listed ids with a change", () => {
		assert.equal(checkCorrections([{ id: "a", statement: "fixed", reason: "index" }], ids), null);
	});
	it("refuses unknown ids, duplicates and empty corrections", () => {
		assert.match(checkCorrections([{ id: "zz", statement: "x", reason: "" }], ids)!, /Unknown/);
		assert.match(checkCorrections([{ id: "a", statement: "x", reason: "" }, { id: "a", name: "y", reason: "" }], ids)!, /twice/);
		assert.match(checkCorrections([{ id: "a", reason: "nothing" }], ids)!, /changes nothing/);
	});
});

describe("checkChainVerdicts", () => {
	const chainIds = new Set(["arg_1", "arg_2"]);
	const nodeIds = new Set(["a", "b"]);
	it("accepts listed chains repaired with existing nodes", () => {
		assert.equal(checkChainVerdicts({ repairs: [{ chainId: "arg_1", premises: ["a"], reason: "" }], deletions: [{ chainId: "arg_2", reason: "" }] }, chainIds, nodeIds), null);
	});
	it("refuses unknown chains, double verdicts and unknown premises", () => {
		assert.match(checkChainVerdicts({ repairs: [], deletions: [{ chainId: "arg_9", reason: "" }] }, chainIds, nodeIds)!, /Unknown chain/);
		assert.match(checkChainVerdicts({ repairs: [{ chainId: "arg_1", premises: ["a"], reason: "" }], deletions: [{ chainId: "arg_1", reason: "" }] }, chainIds, nodeIds)!, /one verdict/);
		assert.match(checkChainVerdicts({ repairs: [{ chainId: "arg_1", premises: ["zz"], reason: "" }], deletions: [] }, chainIds, nodeIds)!, /Unknown node/);
	});
});

describe("duplicatePrompt", () => {
	it("lists each record with its candidates and ids", () => {
		const text = duplicatePrompt([{ record: a, candidates: [b] }]);
		assert.match(text, /RECORD a :: A/);
		assert.match(text, /- b :: B/);
	});
});
