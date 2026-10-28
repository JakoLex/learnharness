import React from "react";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveConversationSpec, resolveModelSpec, resolveSlot } from "../src/core/settings-resolution.ts";
import { parseModelsSettingsBody } from "../src/server/settings-body.ts";
import { clampModelsLevels, validateModelsSettings } from "../src/server/model-catalog.ts";
import { composeSlotFallback, composeSlotModel } from "../components/settings/agent-section.tsx";
import { turnCost } from "../src/core/prices.ts";
import { accumulateJobUsage } from "../src/core/contracts/jobs.ts";
import { projectView } from "../src/core/view.ts";
import { MODEL_FALLBACK_DIAGNOSTIC, type ModelFallbackNote } from "../src/core/model-fallback.ts";
import { ContextDialogBody } from "../components/context-dialog.tsx";
import { ActivitySection } from "../components/activity-dock.tsx";
import type { CallUsage, LhMessage, ModelsSettings, TurnUsage } from "../src/core/index.ts";

// The fallback model's settings + presentation (fallback wave, owner
// 2026-10-28): one optional fallback per slot, resolved onto every role of
// the tier, billed per call to the model that ran, noted once per group.

const A = { provider: "anthropic", id: "claude-haiku-4-5" };
const B = { provider: "openrouter", id: "anthropic/claude-haiku-4.5" };

describe("slot fallback: record, resolution, write side", () => {
	it("the sanitizer keeps a well-formed fallback and drops junk", () => {
		const record = sanitizeUserSettings({
			version: 1,
			models: {
				strong: { model: A, fallback: { model: B, thinkingLevel: "low" } },
				cheap: { model: A, fallback: { model: "junk" } },
			},
		});
		assert.deepEqual(record?.models?.strong, { model: A, fallback: { model: B, thinkingLevel: "low" } });
		assert.deepEqual(record?.models?.cheap, { model: A });
	});

	it("resolution carries the tier's fallback onto slots, roles and conversations", () => {
		const models: ModelsSettings = { strong: { model: A, fallback: { model: B } }, cheap: { model: A, fallback: { model: B, thinkingLevel: "high" } } };
		assert.deepEqual(resolveSlot(models.strong)?.fallback, B);
		assert.deepEqual(resolveModelSpec("researcher", undefined, models)?.fallback, { ...B, thinkingLevel: "high" });
		// A role override keeps its tier's fallback.
		assert.deepEqual(resolveModelSpec("researcher", { model: { provider: "openai", id: "gpt-5" } }, models)?.fallback, { ...B, thinkingLevel: "high" });
		// The conversation's chat model rides the strong slot's fallback.
		const strong = resolveSlot(models.strong);
		assert.deepEqual(resolveConversationSpec({ model: { provider: "openai", id: "gpt-5" } }, strong)?.fallback, B);
	});

	it("a fallback naming the very model it backs up resolves to none", () => {
		const strong = resolveSlot({ model: A, fallback: { model: B } });
		assert.equal(resolveConversationSpec({ model: B }, strong)?.fallback, undefined);
		assert.equal(resolveSlot({ model: A, fallback: { model: A } })?.fallback, undefined);
	});

	it("the strict parser accepts a fallback with a model and rejects one without", () => {
		const ok = parseModelsSettingsBody({ strong: { model: A, fallback: { model: B, thinkingLevel: "low" } } });
		assert.deepEqual(ok, { ok: true, settings: { strong: { model: A, fallback: { model: B, thinkingLevel: "low" } } } });
		const bad = parseModelsSettingsBody({ strong: { model: A, fallback: { thinkingLevel: "low" } } });
		assert.equal(bad.ok, false);
	});

	it("validation gates a new fallback on the catalog and refuses subscriptions", () => {
		assert.deepEqual(validateModelsSettings({ strong: { model: A, fallback: { model: B } } }), { ok: true });
		const missing = validateModelsSettings({ strong: { model: A, fallback: { model: { provider: "openrouter", id: "no-such-model" } } } });
		assert.equal(missing.ok, false);
		const subscription = validateModelsSettings({ strong: { model: A, fallback: { model: { provider: "chatgpt", id: "gpt-5" } } } });
		assert.deepEqual(subscription, { ok: false, error: "A subscription model cannot be a fallback (strong)" });
	});

	it("the write clamps the fallback's level against the fallback's own model", () => {
		const out = clampModelsLevels({ strong: { model: A, fallback: { model: B, thinkingLevel: "low" } } });
		assert.deepEqual(out.strong?.fallback?.model, B);
		assert.ok(out.strong?.fallback?.thinkingLevel);
	});

	it("slot edits keep the fallback; fallback edits keep the slot", () => {
		const models: ModelsSettings = { strong: { model: A, thinkingLevel: "low", fallback: { model: B } } };
		assert.deepEqual(composeSlotModel(models, "strong", "", "", "high").strong, { model: A, thinkingLevel: "high", fallback: { model: B } });
		assert.deepEqual(composeSlotFallback(models, "strong", B.provider, B.id, "medium").strong, {
			model: A,
			thinkingLevel: "low",
			fallback: { model: B, thinkingLevel: "medium" },
		});
		assert.deepEqual(composeSlotFallback(models, "strong", "", "", "").strong, { model: A, thinkingLevel: "low" });
		// No slot model → nothing to back up.
		assert.deepEqual(composeSlotFallback({}, "cheap", B.provider, B.id, ""), {});
	});
});

describe("fallback usage + presentation", () => {
	const step = (over: Partial<CallUsage> = {}): CallUsage => ({
		inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ...over,
	});

	it("a call stamped with its fallback is priced as the fallback", () => {
		const seen: string[] = [];
		turnCost({ model: "a:primary", steps: [step(), step({ model: "b:fallback" })] }, (_usage, model) => {
			seen.push(model);
			return 1;
		});
		assert.deepEqual(seen, ["a:primary", "b:fallback"]);
	});

	it("job usage records the fallback per call", () => {
		const usage = accumulateJobUsage(undefined, "a:primary", { inputTokens: 5, outputTokens: 1 }, "b:fallback");
		assert.equal(usage.model, "a:primary");
		assert.equal(usage.calls?.[0]?.model, "b:fallback");
	});

	const note: ModelFallbackNote = { from: "slopgate:big", to: "openrouter:small", reason: "Connection error.", skipped: false };
	const served = (id: string, text: string): LhMessage =>
		({
			...fauxAssistantMessage([fauxText(text)]),
			id,
			diagnostics: [{ type: MODEL_FALLBACK_DIAGNOSTIC, timestamp: 1, error: { message: note.reason }, details: { from: note.from, to: note.to, skipped: false } }],
		}) as LhMessage;

	it("the transcript shows the note once per group", () => {
		const view = projectView([
			{ id: "u1", role: "user", content: "hi", timestamp: 0 } as LhMessage,
			served("a1", "first step"),
			served("a2", "second step"),
		]);
		const notes = view.flatMap((m) => m.parts.filter((p) => p.type === "data-model-fallback"));
		assert.equal(notes.length, 1);
		assert.deepEqual(notes[0]!.data, note);
	});

	it("the context panel names the fallback in the turns list and the headline", () => {
		const turn: TurnUsage = { id: "t1", messageId: "m1", at: "2026-10-28T00:00:00Z", model: "slopgate:big", steps: [step({ model: "openrouter:small" })] };
		const html = renderToStaticMarkup(
			<ContextDialogBody turns={[turn]} messages={[]} contextTokens={110} limit={1000} costLabel="—" unpriced={0} subscription={0} providers={[]} onClose={() => {}} />,
		);
		assert.match(html, /data-testid="turn-fallback"[^>]*> → fallback /);
		assert.match(html, /small · openrouter · Measured at the last request/);
	});

	it("the dock lists a marked-down primary with its fallback window", () => {
		const html = renderToStaticMarkup(
			<ActivitySection feed={{ jobs: [], extractions: [], outages: [{ model: "slopgate:big", until: Date.now() + 60_000, reason: "fetch failed" }] }} />,
		);
		assert.match(html, /data-testid="activity-outage"[^>]*title="fetch failed"/);
		assert.match(html, /big unavailable — fallback until /);
	});
});
