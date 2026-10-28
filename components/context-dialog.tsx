"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { formatUsd, prettyModel, splitQualified } from "@/components/usage-format";
import { cn } from "@/lib/utils";
import {
	contextSegments,
	nativeInputCause,
	subscriptionLabel,
	transcriptComposition,
	type CallUsage,
	type ContextBucket,
	type ContextComposition,
	type LhMessage,
	type SessionPricing,
	type TurnUsage,
} from "@/src/core";

/**
 * The context panel (2026-10-28): what fills the conversation's context
 * window, opened from the stats bar's summary (it replaced the session-stats
 * popover; the turns list moved in here).
 *
 * Adapted from OpenScience (Apache-2.0, github.com/synthetic-sciences/
 * openscience): the layout of its 2.0.151 "Context" dialog and the bar/legend
 * logic of session-context-tab.tsx @ c971e7f. Changed for LearnHarness: React
 * instead of Solid, LH's measured meter as the headline, LH's buckets, the
 * session-stats turns list. See docs/context-panel.md.
 *
 * The headline is the MEASURED meter (context-usage.ts; ? after a
 * compaction) over the catalog limit. The buckets are estimates and only
 * divide that fill into shares: recorded per call from the assembled
 * request (CallUsage.context), else — calls from before the panel — the
 * transcript fallback, where system/definitions read "not recorded".
 */

export const BUCKET_LABELS: Record<ContextBucket, string> = {
	system: "System instructions",
	definitions: "Tool definitions",
	text: "Conversation text",
	reasoning: "Reasoning",
	tool: "Tool calls and results",
	image: "Images",
};

const NUMBER = new Intl.NumberFormat("en-US");
// Two decimals keep 1.05M distinct from a rounded 1.1M (OpenScience).
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const DATE_TIME = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

const count = (value: number | undefined) => (value === undefined ? "—" : NUMBER.format(value));
const percent = (value: number) => (value > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`);
const dateTime = (value: string | number | undefined) => {
	if (value === undefined) return "—";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "—" : DATE_TIME.format(date);
};

export interface ContextView {
	/** The measured meter; null = unknown (post-compaction, no reply yet). */
	total: number | null;
	limit: number | null;
	/** total / limit in percent; null without either. */
	usage: number | null;
	/** Provider-qualified stamp of the latest turn ("provider:id"). */
	model: string | null;
	/** Bucket estimates; null = nothing to estimate yet. */
	composition: Partial<ContextComposition> | null;
	/** true = recorded from the assembled request; false = transcript fallback. */
	recorded: boolean;
	/** The latest model call (the "Last request" card). */
	lastCall: CallUsage | null;
}

/** Pure: the panel's figures from what the stats bar already holds. */
export function contextView({
	turns,
	messages,
	contextTokens,
	limit,
}: {
	turns: readonly TurnUsage[];
	messages: readonly LhMessage[];
	contextTokens: number | null;
	limit: number | null;
}): ContextView {
	const lastTurn = turns.at(-1);
	const lastCall = lastTurn?.steps.at(-1) ?? null;
	const recorded = lastCall?.context;
	return {
		total: contextTokens,
		limit,
		usage: contextTokens !== null && limit ? (contextTokens / limit) * 100 : null,
		// The model that ran the last call — a fallback when one answered.
		model: lastCall?.model ?? lastTurn?.model ?? null,
		composition: recorded ?? transcriptComposition(messages),
		recorded: recorded !== undefined,
		lastCall,
	};
}

/** Pure: the learner's inputs (typed messages, steers, answers, practice
 *  submissions — native causes, never guessed) and the agent's replies. */
export function messageCounts(messages: readonly LhMessage[]): { yours: number; agent: number } {
	let yours = 0;
	let agent = 0;
	const history: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "assistant") agent++;
		else if (nativeInputCause(message as AgentMessage, history) === "learner") yours++;
		history.push(message as AgentMessage);
	}
	return { yours, agent };
}

/** The newest message timestamp — live, unlike the record's updatedAt. */
export function lastActivity(messages: readonly LhMessage[]): number | undefined {
	let latest: number | undefined;
	for (const message of messages) {
		const at = (message as { timestamp?: unknown }).timestamp;
		if (typeof at === "number" && Number.isFinite(at) && (latest === undefined || at > latest)) latest = at;
	}
	return latest;
}

interface ContextDialogData {
	turns: TurnUsage[];
	messages: readonly LhMessage[];
	contextTokens: number | null;
	limit: number | null;
	pricing?: SessionPricing;
	createdAt?: string;
	/** The stats bar's honest cost label ("—" when nothing priced). */
	costLabel: string;
	unpriced: number;
	/** Subscription-billed turns (plan usage, not API dollars). */
	subscription: number;
	providers: readonly string[];
}

export function ContextDialog({ open, onClose, ...data }: ContextDialogData & { open: boolean; onClose: () => void }) {
	const backdropDismiss = useBackdropDismiss(onClose);

	// Esc closes (claimed — a dialog Esc must not also abort a turn).
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// THE ONE-ESC LAW (keyboard round 2026-10-06): claim at the
				// document level — a window-level stopPropagation cannot stop
				// the earlier-registered global window listener.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);

	if (!open) return null;

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<ContextDialogBody {...data} onClose={onClose} />
		</div>,
		document.body,
	);
}

/** The dialog's pure body — exported for SSR pins (the delete-session
 *  body pattern). The wrapper owns the portal, Esc, and backdrop. */
export function ContextDialogBody({
	turns,
	messages,
	contextTokens,
	limit,
	pricing,
	createdAt,
	costLabel,
	unpriced,
	subscription,
	providers,
	onClose,
}: ContextDialogData & { onClose: () => void }) {
	const view = contextView({ turns, messages, contextTokens, limit });
	const segments = view.composition ? contextSegments(view.composition) : [];
	const counts = messageCounts(messages);
	const provider = view.model ? splitQualified(view.model).provider : null;
	const call = view.lastCall;

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Context"
			data-testid="context-dialog"
			onClick={(e) => e.stopPropagation()}
			className="max-h-[calc(100dvh-2rem)] w-[46rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-card p-5 text-card-foreground shadow-xl"
		>
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold">Context</h2>
				<button
					type="button"
					aria-label="Close"
					data-testid="context-close"
					onClick={onClose}
					className="flex size-7 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:text-foreground"
				>
					✕
				</button>
			</div>

			{/* Headline: the measured meter over the catalog limit. */}
			<div className="mt-4 flex items-baseline justify-between gap-3">
				<div className="flex items-baseline gap-2">
					<span data-testid="context-total" className="text-3xl tabular-nums text-foreground">
						{view.total === null ? "?" : COMPACT.format(view.total)}
					</span>
					<span className="text-sm text-muted-foreground">
						{view.limit ? `of ${COMPACT.format(view.limit)} tokens` : "tokens"}
					</span>
				</div>
				{view.usage !== null && (
					<span data-testid="context-percent" className="text-sm tabular-nums text-foreground">
						{percent(view.usage)}
					</span>
				)}
			</div>
			{/* The bar fills to the measured share; the buckets divide it. */}
			<div
				role="img"
				aria-label={view.usage === null ? "Context usage unknown" : `${percent(view.usage)} of the context window used`}
				data-testid="context-bar"
				className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full bg-accent"
			>
				{view.usage !== null &&
					segments
						.filter((segment) => segment.share > 0)
						.map((segment) => (
							<span
								key={segment.key}
								data-testid={`context-bar-${segment.key}`}
								className="h-full rounded-full"
								style={{
									width: `${Math.max(0, Math.min(100, view.usage! * segment.share))}%`,
									background: `var(--lh-ctx-${segment.key})`,
								}}
							/>
						))}
			</div>
			<div data-testid="context-subline" className="mt-2.5 text-xs text-muted-foreground">
				{[
					view.model ? prettyModel(view.model) : null,
					provider,
					view.total === null ? "Unknown until the next reply" : "Measured at the last request",
				]
					.filter(Boolean)
					.join(" · ")}
			</div>

			<div className="mt-4 border-t pt-4">
				<h3 className="text-xs text-muted-foreground">What fills the window</h3>
				{segments.length === 0 ? (
					<p className="mt-2 text-sm text-muted-foreground">Nothing yet — the breakdown appears after the first reply.</p>
				) : (
					<ul className="mt-1 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
						{segments.map((segment) => (
							<li
								key={segment.key}
								data-testid={`context-bucket-${segment.key}`}
								className={cn(
									"flex items-center gap-2.5 border-b border-border/40 py-2 text-sm",
									!segment.tokens && "text-muted-foreground",
								)}
							>
								<i
									aria-hidden
									className="size-2.5 shrink-0 rounded-[3px]"
									style={{ background: segment.tokens ? `var(--lh-ctx-${segment.key})` : "var(--accent)" }}
								/>
								<span className="min-w-0 flex-1 truncate">{BUCKET_LABELS[segment.key]}</span>
								<span className="tabular-nums">
									{segment.tokens === undefined ? "not recorded" : `~${NUMBER.format(segment.tokens)}`}
								</span>
								<span className="w-9 text-right tabular-nums text-muted-foreground">
									{segment.share > 0 ? percent(segment.share * 100) : ""}
								</span>
							</li>
						))}
					</ul>
				)}
				<p data-testid="context-note" className="mt-3 max-w-[36rem] text-xs text-muted-foreground">
					{view.recorded
						? "Estimated from the last request as it was sent, including the tool-definition schemas that ride along with every request. Images count a fixed allowance each. Provider-specific wrappers are not counted, so the shares can read a little off the provider's own split."
						: "Estimated from the transcript: this request predates the breakdown, so system instructions and tool definitions are not recorded. The next reply records the full request."}
				</p>
			</div>

			<div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
				<section data-testid="context-last-request" className="rounded-xl border p-4">
					<h3 className="mb-2 text-xs text-muted-foreground">Last request</h3>
					<dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
						<dt className="text-muted-foreground">Input tokens</dt>
						<dd className="text-right tabular-nums">{count(call?.inputTokens)}</dd>
						<dt className="text-muted-foreground">Cache read</dt>
						<dd className="text-right tabular-nums">{count(call?.cacheReadTokens)}</dd>
						<dt className="text-muted-foreground">Cache write</dt>
						<dd className="text-right tabular-nums">{count(call?.cacheWriteTokens)}</dd>
						<dt className="text-muted-foreground">Output tokens</dt>
						<dd className="text-right tabular-nums">{count(call?.outputTokens)}</dd>
						<dt className="text-muted-foreground">Reasoning tokens</dt>
						<dd className="text-right tabular-nums">{count(call?.reasoningTokens)}</dd>
					</dl>
				</section>
				<section data-testid="context-session" className="rounded-xl border p-4">
					<h3 className="mb-2 text-xs text-muted-foreground">Session</h3>
					<dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
						<dt className="text-muted-foreground">Messages</dt>
						<dd className="text-right tabular-nums">
							{NUMBER.format(counts.yours + counts.agent)}{" "}
							<span className="text-xs text-muted-foreground">
								{NUMBER.format(counts.yours)} yours · {NUMBER.format(counts.agent)} agent
							</span>
						</dd>
						<dt className="text-muted-foreground">{subscription ? "Usage" : "Total cost"}</dt>
						<dd data-testid="context-cost" className="text-right tabular-nums">{costLabel}</dd>
						{unpriced > 0 && (
							<>
								<dt className="text-muted-foreground">Unpriced turns</dt>
								<dd className="text-right tabular-nums">{NUMBER.format(unpriced)}</dd>
							</>
						)}
						<dt className="text-muted-foreground">Session created</dt>
						<dd className="text-right tabular-nums">{dateTime(createdAt)}</dd>
						<dt className="text-muted-foreground">Last activity</dt>
						<dd className="text-right tabular-nums">{dateTime(lastActivity(messages))}</dd>
					</dl>
					{providers.includes("ChatGPT") && (
						<a
							href="https://chatgpt.com/settings/usage"
							target="_blank"
							rel="noreferrer"
							className="mt-2 inline-block text-xs text-muted-foreground underline underline-offset-2"
						>
							Manage ChatGPT usage
						</a>
					)}
				</section>
			</div>

			{turns.length > 0 && (
				<section data-testid="context-turns" className="mt-4">
					<h3 className="mb-1.5 text-xs text-muted-foreground">Turns</h3>
					<ul className="flex max-h-56 flex-col gap-1 overflow-y-auto text-xs">
						{turns.map((turn, i) => {
							const c = pricing?.turnCosts[turn.id] ?? null;
							const fallbacks = [...new Set(turn.steps.flatMap((step) => (step.model ? [step.model] : [])))];
							return (
								<li key={`${turn.messageId}-${i}`} className="flex items-center justify-between gap-2">
									<span className="truncate text-muted-foreground">
										#{i + 1} · {prettyModel(turn.model, true)}
										{fallbacks.length > 0 && (
											<span data-testid="turn-fallback"> → fallback {fallbacks.map((m) => prettyModel(m, true)).join(", ")}</span>
										)}
									</span>
									<span className="flex shrink-0 items-center gap-2 tabular-nums">
										<span className="text-muted-foreground">{turn.steps.length} steps</span>
										<span>{subscriptionLabel(turn.model) ?? (c === null ? "—" : formatUsd(c))}</span>
									</span>
								</li>
							);
						})}
					</ul>
				</section>
			)}
		</div>
	);
}
