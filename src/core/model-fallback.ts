/**
 * THE FALLBACK MODEL VOCABULARY (fallback wave, owner-approved 2026-10-28):
 * the client-safe half of the per-slot fallback — the marker a fallback
 * answer carries, and the outage rows the activity feed ships. The stream
 * wrapper that writes them lives in src/agent/model-fallback.ts.
 *
 * The marker rides pi's own `diagnostics` list on the assistant message
 * (persisted natively with the record, never sent to a provider): one
 * entry of type MODEL_FALLBACK_DIAGNOSTIC naming the primary that failed,
 * the fallback that answered, and the primary's error. A message without
 * it was answered by its primary.
 */

/** The diagnostics `type` a fallback-served message carries. */
export const MODEL_FALLBACK_DIAGNOSTIC = "lh.model_fallback" as const;

/** What the transcript note and the usage stamp read off a fallback answer. */
export interface ModelFallbackNote {
	/** The primary that did not answer, provider-qualified ("provider:id"). */
	from: string;
	/** The fallback that answered (or also failed), provider-qualified. */
	to: string;
	/** The primary's error text; for a skipped primary, the error that
	 *  marked it down. */
	reason: string;
	/** True when the primary was not tried because it is marked down. */
	skipped: boolean;
}

/** The fallback note of an assistant message, or undefined when its
 *  primary answered. Tolerates any shape (records, live partials). */
export function modelFallbackOf(message: unknown): ModelFallbackNote | undefined {
	const diagnostics = (message as { diagnostics?: unknown } | null)?.diagnostics;
	if (!Array.isArray(diagnostics)) return undefined;
	for (const entry of diagnostics) {
		const d = entry as { type?: unknown; error?: { message?: unknown }; details?: Record<string, unknown> };
		if (d?.type !== MODEL_FALLBACK_DIAGNOSTIC || !d.details) continue;
		const { from, to, skipped } = d.details;
		if (typeof from !== "string" || typeof to !== "string") continue;
		return {
			from,
			to,
			reason: typeof d.error?.message === "string" ? d.error.message : "",
			skipped: skipped === true,
		};
	}
	return undefined;
}

/** One primary currently marked down (activity feed row): calls skip it
 *  and go straight to their fallback until `until` (epoch ms). */
export interface ModelOutage {
	/** Provider-qualified primary ("provider:id"). */
	model: string;
	until: number;
	/** The error that marked it down. */
	reason: string;
}

/** How long an availability failure marks a primary down (owner, 2026-10-28). */
export const MODEL_OUTAGE_MS = 5 * 60_000;
