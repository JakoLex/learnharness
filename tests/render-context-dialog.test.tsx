import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { ContextDialogBody, contextView, lastActivity, messageCounts } from "../components/context-dialog.tsx";
import { StatsBar } from "../components/stats-bar.tsx";
import type { CallUsage, LhMessage, TurnUsage } from "../src/core/index.ts";

// The context panel (2026-10-28): the measured headline, the estimated
// buckets dividing the bar, the recorded-vs-fallback note, the cards, and
// the turns list that moved in from the session-stats popover.

const call = (over: Partial<CallUsage> = {}): CallUsage => ({
	inputTokens: 416, outputTokens: 347, cacheReadTokens: 133_575, cacheWriteTokens: 0, reasoningTokens: 12, ...over,
});
const turn = (over: Partial<TurnUsage> = {}): TurnUsage => ({
	id: "t1", messageId: "m1", at: "2026-10-28T00:00:00Z", model: "openrouter:z-ai/glm-5.3-flash", steps: [call()], ...over,
});
const user = (id: string, text: string, timestamp = 1): LhMessage => ({ id, role: "user", content: text, timestamp }) as LhMessage;
const reply = (id: string, text: string, timestamp = 2): LhMessage => ({ ...fauxAssistantMessage([fauxText(text)]), id, timestamp }) as LhMessage;
const recorded = { system: 100, definitions: 100, text: 200, reasoning: 0, tool: 600, image: 0 };

const body = (over: Partial<Parameters<typeof ContextDialogBody>[0]> = {}) =>
	renderToStaticMarkup(
		<ContextDialogBody
			turns={[turn({ steps: [call({ context: recorded })] })]}
			messages={[user("u1", "hello"), reply("a1", "world")]}
			contextTokens={50_000}
			limit={100_000}
			costLabel="$0.0123"
			unpriced={0}
			subscription={0}
			providers={[]}
			onClose={() => {}}
			{...over}
		/>,
	);

describe("context panel", () => {
	it("headline is the measured meter over the catalog limit", () => {
		const html = body();
		assert.match(html, /data-testid="context-total"[^>]*>50K</);
		assert.match(html, /of 100K tokens/);
		assert.match(html, /data-testid="context-percent"[^>]*>50%</);
		assert.match(html, /glm-5\.3-flash · openrouter · Measured at the last request/);
	});

	it("the recorded buckets divide the measured fill (bar width = usage × share)", () => {
		const html = body();
		assert.match(html, /data-testid="context-bar-system"[^>]*style="width:5%/);
		assert.match(html, /data-testid="context-bar-tool"[^>]*style="width:30%/);
		assert.ok(!html.includes('data-testid="context-bar-reasoning"'), "a zero bucket takes no width");
		assert.match(html, /data-testid="context-bucket-tool".*?~600.*?60%/);
		assert.match(html, /data-testid="context-bucket-reasoning".*?~0/);
		assert.match(html, /Estimated from the last request as it was sent/);
	});

	it("falls back to the transcript estimate for calls recorded before the panel", () => {
		const html = body({ turns: [turn()] });
		assert.match(html, /data-testid="context-bucket-system".*?not recorded/);
		assert.match(html, /data-testid="context-bucket-definitions".*?not recorded/);
		assert.match(html, /data-testid="context-bucket-text".*?~2.*?100%/, "\"hello\" before the latest reply");
		assert.match(html, /Estimated from the transcript/);
	});

	it("after a compaction the meter is unknown: ?, no percent, no fill", () => {
		const html = body({ contextTokens: null });
		assert.match(html, /data-testid="context-total"[^>]*>\?</);
		assert.ok(!html.includes('data-testid="context-percent"'));
		assert.ok(!html.includes('data-testid="context-bar-'), "no segment without a measurement");
		assert.match(html, /Unknown until the next reply/);
	});

	it("without a catalog limit: usage-only, never an invented window", () => {
		const html = body({ limit: null });
		assert.match(html, />tokens</);
		assert.ok(!html.includes('data-testid="context-percent"'));
	});

	it("cards: the latest call's usage, the session's counts and cost, and the turns list", () => {
		const html = body({ unpriced: 2 });
		assert.match(html, /Input tokens<\/dt><dd[^>]*>416</);
		assert.match(html, /Cache read<\/dt><dd[^>]*>133,575</);
		assert.match(html, /Output tokens<\/dt><dd[^>]*>347</);
		assert.match(html, /1 yours · 1 agent/);
		assert.match(html, /Total cost<\/dt><dd[^>]*>\$0\.0123</);
		assert.match(html, /Unpriced turns<\/dt><dd[^>]*>2</);
		assert.match(html, /data-testid="context-turns".*#1 · glm-5\.3-flash · openrouter/);
	});

	it("subscription turns read as plan usage, with the ChatGPT usage link", () => {
		const html = body({ costLabel: "ChatGPT", subscription: 1, providers: ["ChatGPT"] });
		assert.match(html, /Usage<\/dt><dd[^>]*>ChatGPT</);
		assert.match(html, /Manage ChatGPT usage/);
	});

	it("nothing to estimate before the first reply", () => {
		const html = body({ turns: [], messages: [user("u1", "hello")], contextTokens: null });
		assert.match(html, /the breakdown appears after the first reply/);
	});

	it("pure figures: recorded wins over the fallback; counts and activity from the transcript", () => {
		const messages = [user("u1", "hello", 10), reply("a1", "world", 30), user("u2", "more", 20)];
		assert.equal(contextView({ turns: [turn({ steps: [call({ context: recorded })] })], messages, contextTokens: 1, limit: 2 }).recorded, true);
		assert.equal(contextView({ turns: [turn()], messages, contextTokens: 1, limit: 2 }).recorded, false);
		assert.deepEqual(messageCounts(messages), { yours: 2, agent: 1 });
		assert.equal(lastActivity(messages), 30);
	});

	it("the stats bar summary opens a dialog (closed on first render)", () => {
		const html = renderToStaticMarkup(<StatsBar chatId="fixture" turns={[turn()]} contextTokens={11_000} />);
		assert.match(html, /<button[^>]*aria-haspopup="dialog"[^>]*data-testid="stats-summary"/);
		assert.ok(!html.includes('data-testid="context-dialog"'));
	});
});
