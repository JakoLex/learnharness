import React, { act } from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { StatsBar } from "../components/stats-bar.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import type { ModelCatalogResponse, TurnUsage } from "../src/core/index.ts";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });

// Fork: the summary opens the context dialog (components/context-dialog.tsx),
// whose Session card carries the cache hit rate row.
test("cache hit rate appears only inside the context dialog, follows the session log, and needs no pricing", async () => {
	const originalFetch = globalThis.fetch;
	const catalog: ModelCatalogResponse = { models: [], providers: [], defaults: null,
		slots: { strong: null, cheap: null, vision: null }, rolePins: {} as ModelCatalogResponse["rolePins"] };
	globalThis.fetch = async (input) => {
		if (input === "/api/models") return Response.json(catalog);
		if (input === "/api/settings") return Response.json({ settings: { models: {} } });
		if (input === "/api/chats/fixture") return Response.json({ settings: {} });
		throw new Error(`unexpected fixture request ${String(input)}`);
	};
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const turn = (read: number | undefined, write: number | undefined = 0): TurnUsage => ({
		id: "turn", messageId: "message", at: "2026-10-30T00:00:00Z", model: "unknown:unpriced",
		steps: [{ inputTokens: 100, outputTokens: 100_000, cacheReadTokens: read,
			cacheWriteTokens: write, reasoningTokens: 90_000 }],
	});
	const render = (turns: TurnUsage[]) => root.render(<InteractionLayersProvider><StatsBar chatId="fixture" turns={turns} contextTokens={42_000} /></InteractionLayersProvider>);
	const cacheRow = () => document.querySelector('[data-testid="stats-cache-hit-rate"]');
	const summary = () => host.querySelector<HTMLButtonElement>('[data-testid="stats-summary"]')!;
	try {
		await act(async () => render([turn(900)]));
		const collapsedSummary = summary().textContent;
		assert.equal(collapsedSummary, "42k·—");
		assert.equal(cacheRow(), null);
		assert(!host.textContent?.includes("Cache hit rate"), "no new chip in the collapsed bar");

		await act(async () => summary().click());
		const dialog = document.querySelector('[data-testid="context-dialog"]')!;
		assert.ok(dialog);
		assert.equal(cacheRow()?.textContent, "90.0%");
		assert(dialog.contains(cacheRow()));
		assert.equal(cacheRow()?.previousElementSibling?.textContent, "Cache hit rate");
		assert.equal(summary().textContent, collapsedSummary);

		await act(async () => render([turn(900), { ...turn(0), id: "second", messageId: "second" }]));
		assert.equal(cacheRow()?.textContent, "81.8%", "session totals, not the last request or mean percentages");
		assert.equal(summary().textContent, collapsedSummary);

		for (const turns of [[], [turn(undefined, undefined)], [turn(0)], [turn(0, 900)]]) {
			await act(async () => render(turns));
			assert.equal(cacheRow(), null, "unknown, empty, all-zero and write-only records stay hidden even while open");
		}
		await act(async () => render([turn(900)]));
		assert.equal(cacheRow()?.textContent, "90.0%");
		await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="context-close"]')!.click());
		assert.equal(document.querySelector('[data-testid="context-dialog"]'), null);
		assert.equal(cacheRow(), null);
		assert.equal(summary().textContent, collapsedSummary);
	} finally {
		await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch;
	}
});
