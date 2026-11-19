"use client";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CornerDownLeftIcon } from "lucide-react";
import { joinDictation, useDictationTarget } from "@/components/dictation";
import { composingQuestionKey, pluginQuestionKeySuppressed } from "./plugin-question-keys";
import { PathInput } from "@/components/path-input";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";

/**
 * The ask-the-tutor field (2026-10-28; born as the reading-thinking field,
 * owner design 2026-10-03, "two questions per teaching unit"): it mounts
 * while a teach-phase check waits (the same cue that collapses the check)
 * and disappears with the question.
 *
 * Asking (owner, 2026-10-28): Enter (or the send arrow) with text parks
 * the check and sends the text to the tutor as the learner's message —
 * the tutor answers, then re-poses the check. Open or closed check alike.
 * Text left unsent when the check is answered still rides the answer as
 * the SEPARATE `readingThinking` channel (never conflated with the quiz
 * thinking) — nothing typed here gets lost.
 *
 * Plugin questions (owner, 2026-11-19): no asking — `askable` absent
 * renders upstream's plain "Thinking while reading" field (no send arrow,
 * plain Enter is a newline, ⌘/Ctrl+Enter blurs), whose text rides the
 * plugin answer.
 *
 * Dictation: while the check sits UNREVEALED this field is the primary
 * target (the dock releases its claim — dictated speech lands here, not
 * in the hidden quiz field); once the learner reveals the check, the dock
 * reclaims and this field is plain typing.
 */
export function ReadingThinkingField({
	value,
	revision,
	onChange,
	onEscape,
	onOpen,
	onAsk,
	askable = false,
	claim,
	inputRef,
}: {
	value: string;
	revision: number;
	onChange: (v: string) => void;
	/** Esc in the field stops dictation (threaded from the page's hook). */
	onEscape?: () => void;
	/** The check waits CLOSED — Enter on an EMPTY field opens it (owner,
	 *  keyboard round 2026-10-06). The caller finishes any live dictation
	 *  FIRST (the flush lands here — the field is the live claim), then
	 *  reveals. Absent = the check is open. */
	onOpen?: () => void;
	/** Park the check and send the field's text to the tutor. Absent =
	 *  asking is not possible right now (a turn or compaction runs, or a
	 *  sibling question dangles): Enter falls back to opening the check. */
	onAsk?: () => void;
	/** The Ask-the-tutor variant — built-in checks only. Absent/false =
	 *  the plain reading-thinking field (plugin questions); onAsk is ignored. */
	askable?: boolean;
	/** Primary dictation claim — true while the check is behind its reveal. */
	claim: boolean;
	inputRef?: RefObject<HTMLDivElement | null>;
}) {
	const controller = useOptionalInteractionLayers();
	const [draft, setDraft] = useState(value);
	// Appends may arrive back-to-back before React commits. Like Chat's
	// submit mirror, this ref includes every edit synchronously.
	const draftRef = useRef(value);
	useLayoutEffect(() => { draftRef.current = value; setDraft(value); }, [revision, value]);
	const applyDraft = useCallback((next: string) => {
		draftRef.current = next;
		setDraft(next);
		onChange(next);
	}, [onChange]);
	useDictationTarget(
		useCallback((text: string) => applyDraft(joinDictation(draftRef.current, text)), [applyDraft]),
		claim,
	);
	const canSend = askable && onAsk !== undefined && draft.trim().length > 0;
	const field = (
		<PathInput
			ref={inputRef}
			value={draft}
			onValueChange={applyDraft}
			/* py-0.5 (owner round, 2026-10-07): the scrollbar fix. Source
			   Sans 3's font box is 22px at 16px; lh-input's 1.25 leading
			   gives a 20px line box — the content area sticks 1px below the
			   line, Chromium counts it in scrollHeight, and a zero-padding
			   textarea turns that into a permanent 1px scroll (the bar shows
			   empty and at every size below max-h). 2px of vertical padding
			   absorbs it — the same absorption the composer and dock fields
			   get implicitly from their py-2. Line-height stays 1.25 (the
			   caret law, typography round 2). */
			onKeyDown={(e) => {
				if (composingQuestionKey(e) || pluginQuestionKeySuppressed(e)) return;
				if (!isInteractionScopeEligible(e.currentTarget, controller)) return;
				if (e.key === "Escape") {
					controller?.claimEscape(e);
					// Esc stops dictation (the strip's rule) — claimed so the
					// window chain doesn't also read it as abort-turn.
					e.preventDefault();
					e.stopPropagation();
					onEscape?.();
					return;
				}
				if (!askable) {
					// The plain field (upstream): while the check sits closed,
					// plain Enter (and ⌘/Ctrl+Enter) opens it; Shift+Enter stays
					// a newline.
					if (e.key === "Enter" && onOpen !== undefined && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						e.stopPropagation();
						onOpen();
						return;
					}
					// Plain Enter is a newline; no submit button here — the
					// check's own submit is this field's carrier — so ⌘↵ blurs.
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						e.currentTarget.blur();
					}
					return;
				}
				// Shift+Enter is a newline; Enter and ⌘/Ctrl+Enter act.
				if (e.key !== "Enter" || (e.shiftKey && !e.metaKey && !e.ctrlKey)) return;
				// With text and asking possible: park the check, ask the tutor.
				if (canSend) {
					e.preventDefault();
					e.stopPropagation();
					onAsk!();
					return;
				}
				// ENTER OPENS THE WAITING CHECK (owner, keyboard round
				// 2026-10-06): the dictation flush lands HERE first via the
				// caller's finishDictation, so unsent text rides along.
				if (onOpen !== undefined) {
					e.preventDefault();
					e.stopPropagation();
					onOpen();
					return;
				}
				// Check open, nothing to send: Enter does nothing.
				e.preventDefault();
			}}
			placeholder={askable ? "Ask anything before the check…" : "Whatever comes to mind as you read."}
			className={askable
				? "field-sizing-content lh-input max-h-40 min-w-0 flex-1 resize-none bg-transparent py-0.5 outline-none placeholder:text-muted-foreground/70"
				: "field-sizing-content lh-input max-h-40 w-full resize-none bg-transparent py-0.5 outline-none placeholder:text-muted-foreground/70"}
		/>
	);
	return (
		<div
			data-testid="reading-thinking-field"
			className="pointer-events-auto mb-2 rounded-2xl border bg-card/60 px-3 py-2 transition-colors focus-within:border-primary/50"
		>
			<div className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{askable ? "Ask the tutor" : "Thinking while reading"}
			</div>
			{askable ? (
				<div className="flex items-end gap-2">
					{field}
					<button
						type="button"
						data-testid="ask-tutor-send"
						aria-label="Ask the tutor"
						disabled={!canSend}
						onClick={() => onAsk?.()}
						className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
					>
						<CornerDownLeftIcon className="size-4" />
					</button>
				</div>
			) : field}
		</div>
	);
}
