import type { AssistantMessage, AssistantMessageEvent, StreamFunction } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/**
 * THE CHAT-STEP GUARD (fork, owner 2026-11-12): limits for ONE model step of
 * a conversation agent (prober, teacher, practice). Import, extraction and
 * the background agents never pass through here and keep their own limits.
 *
 * - Output cap: every step asks for at most CHAT_MAX_TOKENS. A normal chat
 *   step needed at most ~8.5k (plan_init); Qwen 3.8 on NInfer once looped
 *   inside a withheld tool call up to the model's 65,536 (10 minutes).
 * - Stall watchdog: NInfer streams nothing while it holds back an unfinished
 *   tool call — only SSE keep-alives, which never become events. Once the
 *   answer has started (the first thinking, text or tool-call event; the
 *   prefill before it never counts), STALL_MS without a further content
 *   event aborts the request and ends the step as an error whose message
 *   isStallError recognizes. The chat handler then retries such a step once.
 *   A user abort stays an abort.
 */
export const CHAT_MAX_TOKENS = 20_000;
export const STALL_MS = 150_000;

const STALL_MARK = "(LearnHarness stall watchdog)";

export function stallErrorMessage(stallMs: number): string {
	return `No output for ${Math.round(stallMs / 1000)} s after the answer had started — the request was aborted ${STALL_MARK}.`;
}

/** Did the watchdog end this message? */
export function isStallError(message: { role?: string; stopReason?: string; errorMessage?: string }): boolean {
	return message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.endsWith(`${STALL_MARK}.`);
}

/** Should the chat handler retry the turn that just settled? Exactly ONE
 *  failed response at the tail (UI-only plan blocks skipped, the same walk
 *  as Retry's failedTail), and the watchdog ended it. A second stall in a
 *  row — the automatic retry stalled too — stays for the learner's Retry. */
export function stallRetryDue(
	messages: readonly { role: string; stopReason?: string; errorMessage?: string; customType?: string }[],
): boolean {
	const failed: (typeof messages)[number][] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant" && m.stopReason === "error") failed.push(m);
		else if (!(m.role === "custom" && m.customType === "plan-block")) break;
	}
	return failed.length === 1 && isStallError(failed[0]!);
}

const CONTENT_EVENTS = new Set<AssistantMessageEvent["type"]>([
	"text_start",
	"text_delta",
	"text_end",
	"thinking_start",
	"thinking_delta",
	"thinking_end",
	"toolcall_start",
	"toolcall_delta",
	"toolcall_end",
]);

export interface ChatStepLimits {
	maxTokens: number;
	stallMs: number;
}

export function withChatStepGuard(
	streamFn: StreamFunction,
	limits: ChatStepLimits = { maxTokens: CHAT_MAX_TOKENS, stallMs: STALL_MS },
): StreamFunction {
	return (model, context, options) => {
		const controller = new AbortController();
		const outer = options?.signal;
		const forwardAbort = () => controller.abort(outer?.reason);
		if (outer?.aborted) controller.abort(outer.reason);
		else outer?.addEventListener("abort", forwardAbort, { once: true });
		const maxTokens = Math.min(options?.maxTokens ?? model.maxTokens, limits.maxTokens);
		const out = new AssistantMessageEventStream();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let finished = false;
		let ended = false;
		let partial: AssistantMessage | undefined;

		const finish = () => {
			finished = true;
			if (timer) clearTimeout(timer);
			outer?.removeEventListener("abort", forwardAbort);
		};
		const close = () => {
			if (ended) return;
			ended = true;
			out.end();
		};
		const stall = () => {
			if (finished || outer?.aborted) return;
			finish();
			controller.abort(new Error("stalled"));
			// The partial keeps what the learner already saw (thinking, text).
			const base = partial ?? emptyMessage(model);
			const error: AssistantMessage = { ...base, stopReason: "error", errorMessage: stallErrorMessage(limits.stallMs) };
			out.push({ type: "error", reason: "error", error });
			close();
		};
		const arm = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(stall, limits.stallMs);
			(timer as { unref?: () => void }).unref?.();
		};

		void (async () => {
			try {
				for await (const event of streamFn(model, context, { ...options, maxTokens, signal: controller.signal })) {
					if (finished) break;
					if (CONTENT_EVENTS.has(event.type)) {
						partial = (event as { partial: AssistantMessage }).partial;
						arm();
					}
					if (event.type === "done" || event.type === "error") finish();
					out.push(event);
				}
				finish();
				close();
			} catch (err) {
				if (ended) return;
				finish();
				const message: AssistantMessage = {
					...emptyMessage(model),
					stopReason: outer?.aborted ? "aborted" : "error",
					errorMessage: err instanceof Error ? err.message : String(err),
				};
				out.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
				close();
			}
		})();
		return out;
	};
}

function emptyMessage(model: { api: AssistantMessage["api"]; provider: string; id: string }): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "error",
		timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
