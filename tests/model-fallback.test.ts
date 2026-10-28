import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	normalizeContext,
	type AssistantMessage,
	type AssistantMessageEvent,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import {
	clearModelOutages,
	isAvailabilityFailure,
	markModelDown,
	modelDown,
	modelOutages,
	usageServedBy,
	withModelFallback,
} from "../src/agent/model-fallback.ts";
import { piEngineForSpec } from "../src/agent/models.ts";
import { MODEL_OUTAGE_MS, modelFallbackOf } from "../src/core/model-fallback.ts";

// The fallback stream (fallback wave, owner 2026-10-28): a primary that
// fails before its first token is answered by the slot's fallback; a break
// mid-answer and a user abort are not; availability failures mark the
// primary down for five minutes.

const PRIMARY = "faux-primary:p";
const FALLBACK = "faux-fallback:f";
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

function fauxSide(provider: string, id: string, responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]) {
	const faux = createFauxCore({ provider, models: [{ id }] });
	faux.setResponses(responses);
	let calls = 0;
	const stream: StreamFunction = (model, ctx, options) => {
		calls++;
		return faux.streamSimple(model, ctx, options);
	};
	return { faux, stream, model: faux.getModel(), calls: () => calls };
}

function errorMessage(text: string): AssistantMessage {
	return fauxAssistantMessage([], { stopReason: "error", errorMessage: text });
}

async function drain(stream: ReturnType<StreamFunction>): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

function wrapped(primaryResponses: Parameters<typeof fauxSide>[2], fallbackResponses: Parameters<typeof fauxSide>[2]) {
	const primary = fauxSide("faux-primary", "p", primaryResponses);
	const fallback = fauxSide("faux-fallback", "f", fallbackResponses);
	const streamFn = withModelFallback(
		{ key: PRIMARY, stream: primary.stream },
		{ key: FALLBACK, model: fallback.model, stream: fallback.stream },
	);
	return { primary, fallback, streamFn };
}

afterEach(() => clearModelOutages());

describe("withModelFallback", () => {
	it("a primary that fails before its first token is answered by the fallback, marked and noted", async () => {
		const { primary, fallback, streamFn } = wrapped([errorMessage("Connection error.")], [fauxAssistantMessage([fauxText("from fallback")])]);
		const { events, result } = await drain(streamFn(primary.model, context, {}));
		assert.equal(result.stopReason, "stop");
		assert.equal(result.provider, "faux-fallback");
		assert.deepEqual(result.content, [{ type: "text", text: "from fallback" }]);
		assert.deepEqual(modelFallbackOf(result), { from: PRIMARY, to: FALLBACK, reason: "Connection error.", skipped: false });
		assert.equal(usageServedBy(result.usage), FALLBACK);
		// The loop never sees the primary's half-started message.
		assert.ok(events.every((e) => e.type !== "error"));
		assert.equal(events.filter((e) => e.type === "start").length, 1);
		assert.equal(fallback.calls(), 1);
		// Availability failure → down-marked for five minutes.
		assert.deepEqual(modelOutages().map((o) => o.model), [PRIMARY]);
		assert.ok(modelOutages()[0]!.until - Date.now() <= MODEL_OUTAGE_MS);
	});

	it("while the primary is marked down, calls skip it and go straight to the fallback", async () => {
		markModelDown(PRIMARY, "fetch failed");
		const { primary, fallback, streamFn } = wrapped([fauxAssistantMessage("never")], [fauxAssistantMessage("fallback")]);
		const { result } = await drain(streamFn(primary.model, context, {}));
		assert.equal(primary.calls(), 0);
		assert.equal(fallback.calls(), 1);
		assert.deepEqual(modelFallbackOf(result), { from: PRIMARY, to: FALLBACK, reason: "fetch failed", skipped: true });
	});

	it("an expired down-mark lets the primary answer again", () => {
		markModelDown(PRIMARY, "fetch failed", Date.now() - MODEL_OUTAGE_MS - 1);
		assert.equal(modelDown(PRIMARY), undefined);
		assert.deepEqual(modelOutages(), []);
	});

	it("a request-specific failure falls back WITHOUT marking the primary down", async () => {
		const { primary, streamFn } = wrapped(
			[errorMessage("400 This model's maximum context length is exceeded")],
			[fauxAssistantMessage("fallback")],
		);
		const { result } = await drain(streamFn(primary.model, context, {}));
		assert.equal(result.provider, "faux-fallback");
		assert.deepEqual(modelOutages(), []);
	});

	it("a break mid-answer keeps the primary's error (no fallback)", async () => {
		const { primary, fallback, streamFn } = wrapped(
			[fauxAssistantMessage([fauxText("half an answ")], { stopReason: "error", errorMessage: "socket hang up" })],
			[fauxAssistantMessage("fallback")],
		);
		const { result } = await drain(streamFn(primary.model, context, {}));
		assert.equal(result.stopReason, "error");
		assert.equal(result.provider, "faux-primary");
		assert.equal(result.errorMessage, "socket hang up");
		assert.equal(fallback.calls(), 0);
		assert.equal(modelFallbackOf(result), undefined);
		assert.deepEqual(modelOutages(), []);
	});

	it("a user abort never falls back", async () => {
		const { primary, fallback, streamFn } = wrapped([fauxAssistantMessage("slow answer")], [fauxAssistantMessage("fallback")]);
		const controller = new AbortController();
		controller.abort();
		const { result } = await drain(streamFn(primary.model, context, { signal: controller.signal }));
		assert.equal(result.stopReason, "aborted");
		assert.equal(fallback.calls(), 0);
	});

	it("a primary that answers passes through untouched", async () => {
		const { primary, fallback, streamFn } = wrapped([fauxAssistantMessage("primary answer")], [fauxAssistantMessage("fallback")]);
		const { result } = await drain(streamFn(primary.model, context, {}));
		assert.equal(result.provider, "faux-primary");
		assert.equal(modelFallbackOf(result), undefined);
		assert.equal(usageServedBy(result.usage), undefined);
		assert.equal(fallback.calls(), 0);
	});

	it("when the fallback fails too, the error names both failures", async () => {
		const { primary, streamFn } = wrapped([errorMessage("503 Service Unavailable")], [errorMessage("401 Unauthorized")]);
		const { result } = await drain(streamFn(primary.model, context, {}));
		assert.equal(result.stopReason, "error");
		assert.equal(
			result.errorMessage,
			`${PRIMARY} failed: 503 Service Unavailable\nFallback ${FALLBACK} failed: 401 Unauthorized`,
		);
		assert.equal(modelFallbackOf(result)?.to, FALLBACK);
	});
});

describe("isAvailabilityFailure", () => {
	const failure = (text: string) => isAvailabilityFailure(errorMessage(text));
	it("network, timeout, 429/5xx, auth and quota mark a primary down", () => {
		for (const text of [
			"Connection error.",
			"fetch failed",
			"Request timed out.",
			"429 Too Many Requests",
			"502 Bad Gateway",
			"401 Unauthorized",
			"Provider is not configured",
			"insufficient_quota",
		]) {
			assert.equal(failure(text), true, text);
		}
	});
	it("request-specific failures do not", () => {
		for (const text of ["400 This model's maximum context length is exceeded", "Invalid tool schema"]) {
			assert.equal(failure(text), false, text);
		}
	});
});

describe("piEngineForSpec fallback wiring", () => {
	it("an API primary with a catalog fallback gets the fallback (its own clamped level)", () => {
		const engine = piEngineForSpec({
			provider: "anthropic",
			id: "claude-haiku-4-5",
			fallback: { provider: "openrouter", id: "anthropic/claude-haiku-4.5", thinkingLevel: "low" },
		});
		assert.equal(engine.model.id, "claude-haiku-4-5");
		assert.equal(engine.fallback?.model.provider, "openrouter");
		assert.equal(engine.fallback?.model.id, "anthropic/claude-haiku-4.5");
		assert.equal(engine.fallback?.level, "low");
	});

	it("a fallback missing from the catalog leaves the primary without one", () => {
		const engine = piEngineForSpec({
			provider: "anthropic",
			id: "claude-haiku-4-5",
			fallback: { provider: "openrouter", id: "no-such-model" },
		});
		assert.equal(engine.fallback, undefined);
	});

	it("a subscription is never a fallback", () => {
		const engine = piEngineForSpec({
			provider: "anthropic",
			id: "claude-haiku-4-5",
			fallback: { provider: "chatgpt", id: "gpt-5" },
		});
		assert.equal(engine.fallback, undefined);
	});
});
