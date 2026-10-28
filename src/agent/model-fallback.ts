import {
	isRetryableAssistantError,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Model,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { emit } from "../core/events.ts";
import { runUnscoped } from "../../config.ts";
import { MODEL_FALLBACK_DIAGNOSTIC, MODEL_OUTAGE_MS, type ModelOutage } from "../core/model-fallback.ts";
import type { BusyVerdict } from "./llama-swap-busy.ts";

/**
 * THE FALLBACK STREAM (fallback wave, owner-approved 2026-10-28): wraps a
 * primary stream function so a call that fails BEFORE ITS FIRST TOKEN is
 * answered by the slot's fallback model instead — one wrapper at the one
 * engine factory (models.ts), so turns, sub-agents, extraction and
 * compaction all inherit it.
 *
 * Rules (owner):
 * - "Before the first token" = no content event yet. The primary's `start`
 *   (sent once the HTTP response opened) is HELD until content arrives, so
 *   an error right after it still falls back and the loop never sees a
 *   half-started primary message.
 * - A user abort never falls back. A break MID-ANSWER keeps today's error +
 *   Retry: the partial answer is the primary's and stands as it is.
 * - Availability failures (network, timeout, 429/5xx, auth, quota) mark
 *   the primary DOWN for MODEL_OUTAGE_MS, process-wide: calls skip it and
 *   go straight to the fallback. Request-specific failures (another 4xx)
 *   fall back without the mark.
 * - The answering message carries a MODEL_FALLBACK_DIAGNOSTIC entry in
 *   pi's native `diagnostics` (persisted, never sent to a provider) — the
 *   transcript note and the usage stamp read it (core/model-fallback.ts).
 * - Subscription routes take no part (owner, 2026-10-28): the engine
 *   factory never wraps a subscription primary nor uses one as fallback.
 */

export interface FallbackSide {
	/** Provider-qualified id ("provider:id"): the outage key and the note. */
	key: string;
	stream: StreamFunction;
	/** BUSY OVERFLOW (overflow wave, owner 2026-10-28): asked before each
	 *  call while the primary is not yet left; busy → wait up to `waitMs`
	 *  (polling every `pollMs`), still busy → the fallback answers, and the
	 *  rest of this engine's calls (one turn / job) stay there. */
	overflow?: {
		check: () => Promise<BusyVerdict>;
		waitMs: number;
		pollMs: number;
	};
}

export interface FallbackTarget extends FallbackSide {
	/** The fallback's own catalog model — the call is re-addressed to it. */
	model: Model<Api>;
}

// ─── The outage registry (process-wide, like the LLM slot pool) ──────────────

interface OutageEntry {
	until: number;
	reason: string;
	timer?: ReturnType<typeof setTimeout>;
}
const OUTAGES_KEY = Symbol.for("lh.modelOutages");
const outageGlobal = globalThis as typeof globalThis & { [OUTAGES_KEY]?: Map<string, OutageEntry> };
const outages = (outageGlobal[OUTAGES_KEY] ??= new Map<string, OutageEntry>());

/** Mark a primary down for MODEL_OUTAGE_MS. The activity feed shows it;
 *  its expiry re-announces so the dock row disappears on time. */
export function markModelDown(key: string, reason: string, now = Date.now()): void {
	const previous = outages.get(key);
	if (previous?.timer) clearTimeout(previous.timer);
	const entry: OutageEntry = { until: now + MODEL_OUTAGE_MS, reason };
	// An outage is process-wide: announce it (and its expiry) outside the
	// failing call's user/project scope, so every window's dock hears it.
	runUnscoped(() => {
		entry.timer = setTimeout(() => {
			if (outages.get(key) === entry) outages.delete(key);
			emit("activity-changed", {});
		}, MODEL_OUTAGE_MS);
		entry.timer.unref?.();
		outages.set(key, entry);
		emit("activity-changed", {});
	});
}

/** The live down-mark of a primary, or undefined when it may be tried. */
export function modelDown(key: string, now = Date.now()): OutageEntry | undefined {
	const entry = outages.get(key);
	if (!entry) return undefined;
	if (entry.until > now) return entry;
	outages.delete(key);
	return undefined;
}

/** Every primary currently marked down (activity feed rows). */
export function modelOutages(now = Date.now()): ModelOutage[] {
	const rows: ModelOutage[] = [];
	for (const [model, entry] of outages) {
		if (entry.until > now) rows.push({ model, until: entry.until, reason: entry.reason });
	}
	return rows.sort((a, b) => a.until - b.until);
}

/** Test seam: forget every down-mark. */
export function clearModelOutages(): void {
	for (const entry of outages.values()) if (entry.timer) clearTimeout(entry.timer);
	outages.clear();
}

// ─── Usage provenance (transient, like subscription-request-cycle's set) ─────

const SERVED_KEY = Symbol.for("lh.fallbackServedUsage");
const servedGlobal = globalThis as typeof globalThis & { [SERVED_KEY]?: WeakMap<object, string> };
const servedUsage = (servedGlobal[SERVED_KEY] ??= new WeakMap<object, string>());

/** The fallback that produced this usage object ("provider:id"), or
 *  undefined when the primary did — the usage collectors stamp it per
 *  call (CallUsage.model) so cost lands on the model that ran. */
export function usageServedBy(usage: object): string | undefined {
	return servedUsage.get(usage);
}

// ─── Classification ──────────────────────────────────────────────────────────

/** Auth and account failures pi's transient classifier leaves out — a
 *  wrong/missing key or an exhausted quota will not heal within the call,
 *  but the provider is unusable all the same. */
const UNUSABLE_PATTERN =
	/(?<![a-z0-9])(?:401|402|403)(?![a-z0-9])|unauthori[sz]ed|forbidden|invalid.?api.?key|incorrect.?api.?key|authentication|not configured|insufficient_quota|quota|billing|out of budget|usage limit/i;

/** True for failures that say the primary itself is unavailable (mark it
 *  down); false for failures specific to this request. */
export function isAvailabilityFailure(message: AssistantMessage): boolean {
	return isRetryableAssistantError(message) || UNUSABLE_PATTERN.test(message.errorMessage ?? "");
}

// ─── The wrapper ─────────────────────────────────────────────────────────────

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

function annotate(message: AssistantMessage, primary: string, fallback: string, reason: string, skipped: boolean, busy: boolean): void {
	if (message.diagnostics?.some((d) => d.type === MODEL_FALLBACK_DIAGNOSTIC)) return;
	message.diagnostics = [
		...(message.diagnostics ?? []),
		{
			type: MODEL_FALLBACK_DIAGNOSTIC,
			timestamp: Date.now(),
			error: { message: reason },
			details: { from: primary, to: fallback, skipped, ...(busy ? { busy: true } : {}) },
		},
	];
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});

/** Ask until free, unreachable, aborted, or out of time (the owner's
 *  15 s wait, 0.5 s polls). */
async function waitWhileBusy(overflow: NonNullable<FallbackSide["overflow"]>, signal?: AbortSignal): Promise<BusyVerdict> {
	const deadline = Date.now() + overflow.waitMs;
	for (;;) {
		const verdict = await overflow.check();
		if (!verdict.busy || verdict.unreachable || signal?.aborted || Date.now() + overflow.pollMs > deadline) return verdict;
		await sleep(overflow.pollMs, signal);
	}
}

/** The primary stream, answered by `fallback` when it fails before its
 *  first token (see the module doc for the rules). */
export function withModelFallback(primary: FallbackSide, fallback: FallbackTarget): StreamFunction {
	// Once a busy primary was left, this engine (one turn / one job) stays
	// on the fallback — no model switch inside an answer (owner, 2026-10-28).
	let leftBusy: string | undefined;
	return (requestModel, context, options) => {
		const out = new AssistantMessageEventStream();
		void (async () => {
			let reason = "";
			let busy = false;
			let down = modelDown(primary.key);
			try {
				if (!down && !leftBusy && primary.overflow && !options?.signal?.aborted) {
					const verdict = await waitWhileBusy(primary.overflow, options?.signal);
					if (verdict.unreachable) {
						markModelDown(primary.key, verdict.reason ?? "unreachable");
						down = modelDown(primary.key);
					} else if (verdict.busy && !options?.signal?.aborted) {
						leftBusy = verdict.reason ?? "busy";
					}
				}
				if (down) {
					reason = down.reason;
				} else if (leftBusy) {
					reason = leftBusy;
					busy = true;
				} else {
					let held: AssistantMessageEvent[] = [];
					let failed: AssistantMessage | undefined;
					let passing = false;
					for await (const event of primary.stream(requestModel, context, options)) {
						if (passing) {
							out.push(event);
							continue;
						}
						if (event.type === "start") {
							held.push(event);
							continue;
						}
						if (event.type === "error" && event.reason === "error" && !options?.signal?.aborted) {
							failed = event.error;
							break;
						}
						// Content, done, or an abort: the primary answers — release.
						passing = true;
						for (const h of held) out.push(h);
						held = [];
						out.push(event);
					}
					if (!failed) {
						out.end();
						return;
					}
					reason = failed.errorMessage || "The model failed before answering.";
					if (isAvailabilityFailure(failed)) markModelDown(primary.key, reason);
				}
				// The fallback answers the very same request: its own model and
				// thinking (the fallback stream pins its level), never the
				// primary's resolved key.
				const skipped = down !== undefined || busy;
				for await (const event of fallback.stream(fallback.model, context, { ...options, apiKey: undefined })) {
					if (event.type === "start" || CONTENT_EVENTS.has(event.type)) {
						annotate((event as { partial: AssistantMessage }).partial, primary.key, fallback.key, reason, skipped, busy);
					} else if (event.type === "done") {
						annotate(event.message, primary.key, fallback.key, reason, skipped, busy);
						servedUsage.set(event.message.usage, fallback.key);
					} else if (event.type === "error") {
						annotate(event.error, primary.key, fallback.key, reason, skipped, busy);
						servedUsage.set(event.error.usage, fallback.key);
						if (event.reason === "error") {
							event.error.errorMessage = `${primary.key} ${busy ? "was busy" : "failed"}: ${reason}\nFallback ${fallback.key} failed: ${event.error.errorMessage ?? "unknown error"}`;
						}
					}
					out.push(event);
				}
				out.end();
			} catch (err) {
				// Never leave the loop hanging: an unexpected throw ends the call
				// as an honest error on the requested model.
				const message: AssistantMessage = {
					role: "assistant",
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					content: [],
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: err instanceof Error ? err.message : String(err),
					timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				out.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
				out.end();
			}
		})();
		return out;
	};
}
