/**
 * Source switches (fork, owner 2026-11-25): NotebookLM-style on/off for
 * what the chat agents take into account — the pure core.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ALL_SOURCES_ON, applySourceInclusionChanges, bookLinkKey, emptySourceInclusion, parseSourceInclusion,
	parseSourceInclusionChanges, sourceSwitches, switchedOffNote, withoutInclusionIds,
} from "../src/core/source-inclusion.ts";

describe("source switches", () => {
	it("store only what is off; a linked book switches its import, an unlinked one itself", () => {
		const books = [{ id: "bk_linked", sourceId: "src_a" }, { id: "bk_plain" }];
		let state = applySourceInclusionChanges(emptySourceInclusion(), [
			{ kind: "source", id: "chat_1", on: false },
			{ kind: "book", id: "bk_linked", on: false },
			{ kind: "book", id: "bk_plain", on: false },
		], books);
		assert.deepEqual(state.off, { sources: ["chat_1", "src_a"], books: ["bk_plain"] });
		const sw = sourceSwitches(state);
		assert.equal(sw.sourceOn("src_a"), false);
		assert.equal(sw.bookOn(books[0]!), false, "the linked book follows its import");
		assert.equal(sw.bookOn(books[1]!), false);
		assert.equal(sw.bookOn({ id: "bk_new" }), true, "new books start on");
		assert.equal(sw.sourceOn("src_new"), true, "new sources start on");
		state = applySourceInclusionChanges(state, [{ kind: "source", id: "src_a", on: true }], books);
		assert.equal(sourceSwitches(state).bookOn(books[0]!), true, "switching the import on switches its book on");
	});

	it("a proposition stays on while ANY of its sources is on", () => {
		const sw = sourceSwitches({ version: 1, off: { sources: ["src_a", "chat_1"], books: [] } });
		assert.equal(sw.nodeOn({ provenance: [{ chatId: "src_a" }] }), false);
		assert.equal(sw.nodeOn({ provenance: [{ chatId: "src_a" }, { chatId: "chat_1" }] }), false);
		assert.equal(sw.nodeOn({ provenance: [{ chatId: "src_a" }, { chatId: "chat_2" }] }), true);
		assert.equal(sw.nodeOn({ provenance: [] }), true, "no provenance counts as on");
		assert.equal(ALL_SOURCES_ON.nodeOn({ provenance: [{ chatId: "src_a" }] }), true);
	});

	it("deleted ids lose their switch, so a re-import of the same path arrives on", () => {
		const state = { version: 1 as const, off: { sources: ["src_a", "src_b"], books: ["bk_1"] } };
		assert.deepEqual(withoutInclusionIds(state, { sources: ["src_a"], books: ["bk_1"] }).off, { sources: ["src_b"], books: [] });
	});

	it("parses the stored file and the change requests strictly", () => {
		assert.deepEqual(parseSourceInclusion({ version: 1, off: { sources: ["b", "a", "a"] } }).off, { sources: ["a", "b"], books: [] });
		assert.throws(() => parseSourceInclusion({ version: 2, off: {} }), /version/);
		assert.throws(() => parseSourceInclusion({ version: 1, off: { sources: [3] } }), /array of ids/);
		assert.deepEqual(parseSourceInclusionChanges({ changes: [{ kind: "book", id: "bk_1", on: true }] }), [{ kind: "book", id: "bk_1", on: true }]);
		assert.throws(() => parseSourceInclusionChanges({ changes: [] }), /at least one/);
		assert.throws(() => parseSourceInclusionChanges({ changes: [{ kind: "folder", id: "f", on: true }] }), /kind/);
		assert.throws(() => parseSourceInclusionChanges({ changes: [{ kind: "source", id: "a", on: "no" }] }), /on: true or false/);
	});

	it("the agents' note says only how many are off", () => {
		assert.equal(switchedOffNote(0, "source"), "");
		assert.equal(switchedOffNote(1, "source"), "(1 source is switched off by the learner.)");
		assert.equal(switchedOffNote(2, "book"), "(2 books are switched off by the learner.)");
	});

	it("imports and books match by file name without folders, extension or case", () => {
		assert.equal(bookLinkKey("Skripte/Newtonsche Mechanik.pdf"), "newtonsche mechanik");
		assert.equal(bookLinkKey("newtonsche mechanik.PDF"), bookLinkKey("Newtonsche Mechanik.pdf"));
		assert.notEqual(bookLinkKey("I_Newtonsche_Mechanik.pptx"), bookLinkKey("Newtonsche Mechanik.pdf"));
	});
});
