"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { subscriptionLabels, type LhMessage, type SessionPricing, type TurnUsage } from "@/src/core";
import { formatTokens, planCostLabel } from "@/components/usage-format";
import { ModelControl, catalogLimits, useModelCatalog } from "@/components/model-picker";
import { ContextDialog } from "@/components/context-dialog";

export function formatContextMeasurement(tokens: number | null, limit: number | null): string {
	const numerator = tokens === null ? "?" : formatTokens(tokens);
	return limit === null ? numerator : `${numerator} / ${formatTokens(limit)}`;
}

/**
 * The below-composer stats bar (wave 4 observability): the session's
 * money/context footprint as one quiet row beneath the composer —
 * LEFT-aligned: context window + session cost; RIGHT-aligned: model +
 * thinking level. Clicking the left side opens the context panel
 * (components/context-dialog.tsx, 2026-10-28 — it replaced the per-turn
 * session-stats popover and carries its turns list).
 *
 *  Pre-chat views (home, /chat/new) render NO left side at all (owner,
 *  wave 7 sweep: the knowledge-context budget slider that used to live
 *  there died with the injection; a "— · —" summary over an empty
 *  popover is pure noise) — the dictation strip's middle simply widens.
 *
 * Spending arrives already priced by the server through Pi's catalog and
 * calculator. Missing cost stays "—", never fake zero. Context is a separate
 * completed-conversation measurement, never a money-log/summarizer fold or
 * transcript estimate. Its catalog denominator follows the selected model;
 * model changes preserve the numerator. Successful compaction clears it to ?.
 */
export function StatsBar({
	turns,
	contextTokens = null,
	pricing,
	dictationSlot,
	chatId,
	leadingSlot,
	onModelChange,
	messages = [],
	createdAt,
}: {
	turns: TurnUsage[];
	contextTokens?: number | null;
	pricing?: SessionPricing;
	/** The bound session (per-session models, owner 2026-09-28): present
	 *  on the in-session bar — the model control binds THE SESSION'S own
	 *  record; absent on the draft surfaces, where it binds the strong
	 *  slot (the new-session default). */
	chatId?: string;
	/** The same effective identity the visible model control owns. */
	onModelChange?: (model: string | undefined) => void;
	/** The dictation strip (STT wave, 2026-09-17): the row's middle is dead
	 *  space between the session data and the model control — the mic
	 *  button lives there, and while recording the meter unfurls to fill
	 *  whatever width the row has (owner placement). */
	dictationSlot?: ReactNode;
	/** The row's LEFT edge (practice sessions, 2026-10-04): the home
	 *  composer's teach | practice switch rides here — before the session
	 *  data (which renders nothing pre-chat on that surface). */
	leadingSlot?: ReactNode;
	/** The session's native transcript — the context panel's message
	 *  counts, last activity, and pre-panel breakdown fallback. */
	messages?: readonly LhMessage[];
	/** The record's creation time (the context panel's Session card). */
	createdAt?: string;
}) {
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	const [selectedModel, setSelectedModel] = useState<string | undefined>();
	const modelChanged = useCallback((model: string | undefined) => {
		setSelectedModel(model);
		onModelChange?.(model);
	}, [onModelChange]);
	// Catalog-only denominator; the picker reports its effective selection.
	// Missing/pending catalog means usage-only, never a hardcoded maximum.
	const { catalog } = useModelCatalog();
	const limits = useMemo(() => (catalog ? catalogLimits(catalog) : undefined), [catalog]);
	const limit = selectedModel ? limits?.get(selectedModel) ?? null : null;
	const contextLabel = formatContextMeasurement(contextTokens, limit);
	const { cost = 0, unpriced = turns.length, subscription = 0 } = pricing ?? {};
	// Honest cost: show dollars only when at least one turn priced;
	// otherwise "—" (never a fake $0.0000).
	const pricedCount = turns.length - unpriced - subscription;
	const providers = pricing?.subscriptionProviders ?? subscriptionLabels(turns.map((turn) => turn.model));
	const costLabel = planCostLabel(pricedCount > 0 ? cost : null, providers);

	return (
		<div
			data-testid="stats-bar"
			// pointer-events-auto: the sticky composer wrapper is pointer-events-none
			// (so its transparent gradient area never blocks scrolling) — this row
			// must re-enable events or every control on it is dead (the model-
			// control wave caught this live: buttons rendered, clicks never landed).
			className="pointer-events-auto relative flex items-center justify-between gap-3 px-3 pt-2 text-xs text-muted-foreground"
		>
			{/* The leading slot (2026-10-04): the leftmost control surface —
			    the home composer's mode switch. */}
			{leadingSlot}
			{/* The left side: the session-data summary — only once a session
			    exists (turns). Pre-chat renders nothing (see the header). */}
			{(chatId || turns.length > 0) && (
				<>
					{/* No tooltip — the numbers describe themselves and the panel
					    speaks on click (owner, subtlety round 2026-09-25). */}
					<button
						type="button"
						onClick={() => setOpen(true)}
						aria-haspopup="dialog"
						aria-expanded={open}
						data-testid="stats-summary"
						className="flex items-center gap-1.5 tabular-nums transition-colors hover:text-foreground"
					>
						<span data-testid="stats-context">
							{contextLabel}
						</span>
						<span aria-hidden>·</span>
						<span data-testid="stats-cost">{costLabel}</span>
					</button>
					<ContextDialog
						open={open}
						onClose={close}
						turns={turns}
						messages={messages}
						contextTokens={contextTokens}
						limit={limit}
						pricing={pricing}
						createdAt={createdAt}
						costLabel={costLabel}
						unpriced={unpriced}
						subscription={subscription}
						providers={providers}
					/>
				</>
			)}
			{/* The middle slot: dictation (owner, 2026-09-17). flex-1 lets the
			    meter expand into the row's free width; justify-center keeps the
			    lone idle mic button visually centered. */}
			{dictationSlot && (
				<div className="flex min-w-0 flex-1 items-center justify-center">{dictationSlot}</div>
			)}
			{/* The model + thinking control — one controller for the conversation
			    agents (prober/teacher); the record's `turns` above still folds
			    the ACTUAL models billed, regardless of what the picker says. */}
			<ModelControl chatId={chatId} onModelChange={modelChanged} />
		</div>
	);
}
