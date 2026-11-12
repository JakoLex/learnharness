/**
 * The chat-step guard (fork, owner 2026-11-12): every conversation step asks
 * for at most 20k output tokens, and once the answer has started a silence
 * of STALL_MS aborts the request as a stall error — the prefill before the
 * first content event never counts, and a user abort stays an abort. The
 * chat handler retries a stalled turn once (stallRetryDue).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	normalizeContext,
	type AssistantMessage,
	type AssistantMessageEvent,
	type SimpleStreamOptions,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
	CHAT_MAX_TOKENS,
	isStallError,
	stallErrorMessage,
	stallRetryDue,
	withChatStepGuard,
} from "../src/agent/chat-step-guard.ts";

const model = { ...createFauxCore({ provider: "faux", models: [{ id: "m" }] }).getModel(), maxTokens: 65_536 };
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Step = { wait: number; event: (partial: AssistantMessage) => AssistantMessageEvent };

/** A scripted provider: each step waits, then emits; an abort ends it the
 *  way pi's providers do (an "aborted" error). Records what it was asked. */
function scripted(steps: Step[]) {
	const seen: { options?: SimpleStreamOptions; aborted: boolean } = { aborted: false };
	const streamFn: StreamFunction = (_model, _context, options) => {
		seen.options = options;
		const out = new AssistantMessageEventStream();
		const partial = fauxAssistantMessage([], { stopReason: "stop" });
		void (async () => {
			for (const step of steps) {
				await sleep(step.wait);
				if (options?.signal?.aborted) {
					seen.aborted = true;
					out.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted", errorMessage: "Request was aborted" } });
					out.end();
					return;
				}
				out.push(step.event(partial));
			}
			out.end();
		})();
		return out;
	};
	return { streamFn, seen };
}

const start: Step["event"] = (partial) => ({ type: "start", partial });
const thinking: Step["event"] = (partial) => {
	partial.content = [{ type: "thinking", thinking: "Let me ask this." }];
	return { type: "thinking_delta", contentIndex: 0, delta: "Let me ask this.", partial };
};
const done: Step["event"] = (partial) => ({ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } });

async function drain(stream: ReturnType<StreamFunction>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

describe("withChatStepGuard — output cap", () => {
	it("asks for at most CHAT_MAX_TOKENS, keeping a smaller request", async () => {
		const big = scripted([{ wait: 0, event: done }]);
		await drain(withChatStepGuard(big.streamFn)(model, context, {}));
		assert.equal(CHAT_MAX_TOKENS, 20_000);
		assert.equal(big.seen.options?.maxTokens, 20_000);
		const small = scripted([{ wait: 0, event: done }]);
		await drain(withChatStepGuard(small.streamFn)(model, context, { maxTokens: 4096 }));
		assert.equal(small.seen.options?.maxTokens, 4096);
	});
});

describe("withChatStepGuard — stall watchdog", () => {
	const limits = { maxTokens: CHAT_MAX_TOKENS, stallMs: 60 };

	it("never counts the prefill before the first content event", async () => {
		const s = scripted([{ wait: 0, event: start }, { wait: 150, event: thinking }, { wait: 10, event: done }]);
		const { result } = await drain(withChatStepGuard(s.streamFn, limits)(model, context, {}));
		assert.equal(result.stopReason, "stop");
		assert.equal(s.seen.aborted, false);
	});

	it("aborts a silence after the answer started and ends the step as a stall error", async () => {
		const s = scripted([{ wait: 0, event: start }, { wait: 5, event: thinking }, { wait: 400, event: done }]);
		const { events, result } = await drain(withChatStepGuard(s.streamFn, limits)(model, context, {}));
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, stallErrorMessage(60));
		assert.equal(isStallError(result), true);
		// What the learner already saw stays on the failed message.
		assert.deepEqual(result.content, [{ type: "thinking", thinking: "Let me ask this." }]);
		assert.equal(events.at(-1)?.type, "error");
		await sleep(420);
		assert.equal(s.seen.aborted, true, "the upstream request was aborted");
	});

	it("keeps a steady stream alive however long it runs", async () => {
		const steps: Step[] = [{ wait: 0, event: start }];
		for (let i = 0; i < 8; i++) steps.push({ wait: 30, event: thinking });
		steps.push({ wait: 30, event: done });
		const { result } = await drain(withChatStepGuard(scripted(steps).streamFn, limits)(model, context, {}));
		assert.equal(result.stopReason, "stop");
	});

	it("leaves a user abort an abort", async () => {
		const controller = new AbortController();
		const s = scripted([{ wait: 0, event: start }, { wait: 5, event: thinking }, { wait: 30, event: done }]);
		const stream = withChatStepGuard(s.streamFn, limits)(model, context, { signal: controller.signal });
		setTimeout(() => controller.abort(), 15);
		const { result } = await drain(stream);
		assert.equal(result.stopReason, "aborted");
		assert.equal(isStallError(result), false);
	});
});

describe("stallRetryDue", () => {
	const user = { role: "user" };
	const stalled = { role: "assistant", stopReason: "error", errorMessage: stallErrorMessage(150_000) };
	const other = { role: "assistant", stopReason: "error", errorMessage: "An error occurred." };
	const plan = { role: "custom", customType: "plan-block" };

	it("retries one stalled response at the tail, plan blocks skipped", () => {
		assert.equal(stallRetryDue([user, stalled]), true);
		assert.equal(stallRetryDue([user, stalled, plan]), true);
	});
	it("never retries a second stall in a row, another error, or a healthy tail", () => {
		assert.equal(stallRetryDue([user, stalled, stalled]), false);
		assert.equal(stallRetryDue([user, other]), false);
		assert.equal(stallRetryDue([user, { role: "assistant", stopReason: "stop" }]), false);
		assert.equal(stallRetryDue([]), false);
	});
});
