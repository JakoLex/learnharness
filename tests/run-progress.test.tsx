/**
 * Progress bars (fork, owner 2026-11-25): the graph's import pill and the
 * shelf. The owner's decisions: reading restarts the bar per loader step;
 * an import's extraction is one bar over its sections, each split by phase
 * (extracting up to 60 %, auditing up to 90 %, merging to 100 %).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loaderProgress, runProgress } from "../lib/run-progress.ts";
import { ProgressBar } from "../components/progress-bar.tsx";
import { PipelineRunPill } from "../components/graph-view.tsx";
import { BookRow, bookProgress } from "../components/books-shelf.tsx";
import type { BookRecord } from "../src/core/index.ts";

describe("progress texts and fractions", () => {
	it("reading: per loader step, exact pages; no numbers = no fill level", () => {
		assert.deepEqual(loaderProgress({ state: "running", phase: "docling", page: 120, pages: 291 }),
			{ fraction: 120 / 291, text: "Step 1/2 · Docling · page 120/291" });
		assert.deepEqual(loaderProgress({ state: "running", phase: "docling2", page: 5, pages: 10 }),
			{ fraction: 0.5, text: "Step 1/2 · Docling (2nd pass) · page 5/10" });
		assert.deepEqual(loaderProgress({ state: "running", phase: "seiten", page: 16, pages: 35, kind: "bild" }),
			{ fraction: 16 / 35, text: "Step 2/2 · formula & image pages 16/35 (image page)" });
		assert.deepEqual(loaderProgress({ state: "waiting", ahead: 1 }), { fraction: null, text: "Waiting for the doc loader (1 file ahead)" });
		assert.deepEqual(loaderProgress({ state: "waiting", ahead: 2 }), { fraction: null, text: "Waiting for the doc loader (2 files ahead)" });
		assert.deepEqual(loaderProgress(undefined), { fraction: null, text: "Reading the document" });
		assert.deepEqual(loaderProgress({ state: "running", phase: "lesen" }), { fraction: null, text: "Reading the document" });
	});

	it("extraction: one bar over the sections, phases at 0 / 60 / 90 % of a section", () => {
		const n = 40;
		assert.deepEqual(runProgress({ phase: "extracting", part: { i: 12, n } }), { fraction: 11 / n, text: "Section 12/40" });
		assert.deepEqual(runProgress({ phase: "auditing", part: { i: 12, n } }), { fraction: 11.6 / n, text: "Section 12/40" });
		assert.deepEqual(runProgress({ phase: "merging", part: { i: 12, n } }), { fraction: 11.9 / n, text: "Section 12/40" });
		assert.deepEqual(runProgress({ phase: "auditing" }), { fraction: 0.6, text: "" }, "one section: no section text");
		assert.equal(runProgress({ phase: "bridging" }), null, "no measure for the bridge pass");
		assert.equal(runProgress({ phase: "reading", reading: { state: "running", phase: "docling", page: 1, pages: 4 } })!.fraction, 0.25);
	});
});

describe("progress bar rendering", () => {
	it("a fraction fills the bar; null pulses without a value", () => {
		const half = renderToStaticMarkup(createElement(ProgressBar, { fraction: 0.5 }));
		assert.ok(half.includes('aria-valuenow="50"'));
		assert.ok(half.includes("width:50%"));
		const none = renderToStaticMarkup(createElement(ProgressBar, { fraction: null }));
		assert.ok(!none.includes("aria-valuenow"));
		assert.ok(none.includes("animate-pulse"));
	});

	it("the import pill keeps its line and adds the bar with the loader's pages", () => {
		const html = renderToStaticMarkup(createElement(PipelineRunPill, {
			now: 10_000,
			run: { id: "src_a", chatId: "src_a", title: "TM-Arrigoni.pdf", phase: "reading", startedAt: 4_000,
				reading: { state: "running", phase: "docling", page: 120, pages: 291 } },
		}));
		assert.ok(html.includes(">reading<"));
		assert.ok(html.includes("TM-Arrigoni.pdf"));
		assert.ok(html.includes(">6s<"));
		assert.ok(html.includes('aria-valuenow="41"'));
		assert.ok(html.includes("Step 1/2 · Docling · page 120/291"));
	});

	it("a chat run without a measure shows no bar", () => {
		const html = renderToStaticMarkup(createElement(PipelineRunPill, {
			run: { id: "c", chatId: "c", title: "Chat", phase: "bridging", startedAt: 0 },
		}));
		assert.ok(!html.includes("progress-bar"));
	});
});

describe("shelf progress", () => {
	const book = (over: Partial<BookRecord>): BookRecord => ({
		id: "bk_1", title: "TM-Arrigoni", fileName: "TM-Arrigoni.pdf", sha256: "x", bytes: 2_600_000, pageCount: 291,
		status: "ready", addedAt: "2026-11-25T00:00:00.000Z", updatedAt: "2026-11-25T00:00:00.000Z", ...over,
	} as BookRecord);

	it("reading through the loader shows its pages; the meaning index its chunks; ready shows none", () => {
		assert.deepEqual(bookProgress(book({ status: "indexing", reading: { state: "running", phase: "seiten", page: 7, pages: 14 } })),
			{ fraction: 0.5, text: "Step 2/2 · formula & image pages 7/14" });
		assert.deepEqual(bookProgress(book({ status: "indexing" })), { fraction: null, text: "" });
		assert.deepEqual(bookProgress(book({ vectors: "running", chunks: 449, embedded: 120 })), { fraction: 120 / 449, text: "" });
		assert.equal(bookProgress(book({ vectors: "done" })), null);
	});

	it("the book row renders the bar under its status line", () => {
		const html = renderToStaticMarkup(createElement(BookRow, {
			book: book({ status: "indexing", activity: "reading the pages (doc loader on the PC)",
				reading: { state: "running", phase: "docling", page: 30, pages: 291 } }),
			on: true, onSwitch: () => {}, onChanged: () => {}, onOpen: () => {},
		}));
		assert.ok(html.includes('data-testid="book-progress"'));
		assert.ok(html.includes("Step 1/2 · Docling · page 30/291"));
	});
});
