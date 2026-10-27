import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import {
	CONTEXT_BUCKETS,
	IMAGE_TOKENS,
	contextComposition,
	contextSegments,
	estimateTextTokens,
	transcriptComposition,
} from "../src/core/context-composition.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// The context panel's estimate (2026-10-28): buckets over the provider
// wire, OpenScience's estimator, the transcript fallback, and the shares
// that divide the measured bar.

const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

describe("estimateTextTokens (OpenScience's Token.estimate)", () => {
	it("counts four ASCII characters per token, rounded up", () => {
		assert.equal(estimateTextTokens(""), 0);
		assert.equal(estimateTextTokens("abcd"), 1);
		assert.equal(estimateTextTokens("abcde"), 2);
	});

	it("counts every non-ASCII UTF-16 unit at least once — umlauts and math are not undercounted", () => {
		assert.equal(estimateTextTokens("äöü"), 3);
		assert.equal(estimateTextTokens("∂Ψ"), 2);
		assert.equal(estimateTextTokens("😀"), 2, "a surrogate pair counts twice");
		assert.equal(estimateTextTokens("Grüße"), 3, "3 ASCII (0.75) + 2 non-ASCII (2), rounded up");
	});
});

describe("contextComposition (one request, bucketed)", () => {
	const tool = { name: "quiz", description: "Ask a check question.", parameters: { type: "object", properties: { q: { type: "string" } } } };
	const wire = [
		{ role: "system", content: "S".repeat(40), sections: { teaching: "x".repeat(8), gone: null }, toolsAdded: [tool], timestamp: 1 },
		{ role: "user", content: "u".repeat(8), timestamp: 2 },
		{ role: "user", content: [{ type: "text", text: "hi!!" }, image], timestamp: 3 },
		fauxAssistantMessage([
			fauxText("aaaa"),
			fauxThinking("t".repeat(8)),
			{ type: "thinking", thinking: "", thinkingSignature: "opaque-encrypted", redacted: true },
			fauxToolCall("quiz", { q: "x" }, { id: "call-1" }),
		]),
		{ role: "toolResult", toolCallId: "call-1", toolName: "quiz", content: [{ type: "text", text: "r".repeat(12) }, image], isError: false, timestamp: 4 },
	] as Message[];

	it("buckets system text + sections, tool declarations, text, reasoning, tool traffic and images", () => {
		assert.deepEqual(contextComposition(wire), {
			system: 10 + 2,
			definitions: estimateTextTokens(JSON.stringify(tool)),
			text: 2 + 1 + 1,
			reasoning: 2,
			tool: estimateTextTokens(`quiz${JSON.stringify({ q: "x" })}`) + 3,
			image: 2 * IMAGE_TOKENS,
		});
	});

	it("redacted thinking is an opaque signature — never measured", () => {
		const only = [fauxAssistantMessage([{ type: "thinking", thinking: "", thinkingSignature: "x".repeat(4000), redacted: true }])] as Message[];
		assert.equal(contextComposition(only).reasoning, 0);
	});

	it("never throws on unknown or broken shapes (it runs inside prepareRequest)", () => {
		const broken = [null, { role: "custom" }, { role: "user" }, { role: "assistant" }, { role: "toolResult" }, { role: "system" }] as unknown as Message[];
		assert.deepEqual(contextComposition(broken), { system: 0, definitions: 0, text: 0, reasoning: 0, tool: 0, image: 0 });
	});
});

describe("transcriptComposition (the pre-panel fallback)", () => {
	const user = (id: string, text: string): LhMessage => ({ id, role: "user", content: text, timestamp: 1 }) as LhMessage;
	const reply = (id: string, text: string): LhMessage => ({ ...fauxAssistantMessage([fauxText(text)]), id }) as LhMessage;

	it("estimates the request of the latest reply: everything before the last assistant message", () => {
		const messages = [user("u1", "aaaa"), reply("a1", "bbbbbbbb"), user("u2", "cccc"), reply("a2", "d".repeat(400))];
		assert.deepEqual(transcriptComposition(messages), { text: 1 + 2 + 1, reasoning: 0, tool: 0, image: 0 });
	});

	it("leaves system/definitions out — the record never holds the system message", () => {
		const composition = transcriptComposition([user("u1", "aaaa"), reply("a1", "b")])!;
		assert.equal("system" in composition, false);
		assert.equal("definitions" in composition, false);
	});

	it("is null before the first reply", () => {
		assert.equal(transcriptComposition([]), null);
		assert.equal(transcriptComposition([user("u1", "hello")]), null);
	});
});

describe("contextSegments (shares of the measured fill)", () => {
	it("divides by the recorded buckets' sum", () => {
		const segments = contextSegments({ system: 100, definitions: 100, text: 200, reasoning: 0, tool: 600, image: 0 });
		assert.deepEqual(segments.map((s) => s.key), [...CONTEXT_BUCKETS]);
		assert.deepEqual(segments.map((s) => s.share), [0.1, 0.1, 0.2, 0, 0.6, 0]);
	});

	it("an unrecorded bucket keeps its legend place with no share", () => {
		const segments = contextSegments({ text: 30, reasoning: 0, tool: 10, image: 0 });
		const system = segments.find((s) => s.key === "system")!;
		assert.equal(system.tokens, undefined);
		assert.equal(system.share, 0);
		assert.equal(segments.find((s) => s.key === "text")!.share, 0.75);
	});

	it("all-zero buckets share nothing (no division by zero)", () => {
		assert.ok(contextSegments({ text: 0 }).every((s) => s.share === 0));
	});
});
