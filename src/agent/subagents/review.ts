/**
 * The graph review's three model stages (fork, owner 2026-11-10): find
 * duplicates, find errors in propositions, check reasoning chains. Each is
 * one submit-agent call on the auditor role; the orchestration (batches,
 * locks, applying verdicts, the protocol) lives in extraction.ts runReview,
 * the ledger operations in core/graph-review.ts. Prompt wording approved by
 * the owner on 2026-11-10.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

type OnStep = (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;

/** Weak-model tolerance: an array argument sent as a JSON string. */
function healArrays(keys: readonly string[]) {
	return (raw: unknown): unknown => {
		if (typeof raw !== "object" || raw === null) return raw;
		const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
		for (const key of keys) {
			const v = out[key];
			if (typeof v !== "string" || v.trim().length === 0) continue;
			try {
				const parsed: unknown = JSON.parse(v);
				if (Array.isArray(parsed)) out[key] = parsed;
			} catch {
				// leave it; schema validation reports the problem
			}
		}
		return out;
	};
}

// ─── 1. duplicates ──────────────────────────────────────────────────────────

const DUPLICATE_INSTRUCTIONS = `You review a knowledge graph for DUPLICATE propositions: two nodes that state the SAME claim. Your input lists
records, each with up to five ranked candidates from the rest of the graph. For each record, decide whether one of
its candidates states the same claim.

SAME CLAIM, NOT SAME TOPIC:
- Paraphrases, rewordings, other notation and other languages of the SAME claim are duplicates.
- NOT duplicates: a definition and a theorem about the defined thing; a premise and its consequence; a special case
  and its generalization (e.g. the inner product on ℂ^d and the dot product in ℝ³); two neighboring results (left
  and right shift); an overview and one of the results it lists.
- WHEN IN DOUBT, KEEP THEM APART: a missed merge leaves a harmless near-duplicate; a wrong merge destroys a
  proposition and re-points its chains.

For every duplicate pair, choose the text the merged node keeps: the name and the statement of ONE of the two
records, copied verbatim — the more precise and complete one (correct notation, no garbled formulas). Do not write
new text. The other statement is kept as a phrasing.

Complete the task by CALLING submit_merges with "merges": [{ "ids": [<id>, <id>], "name": <verbatim>,
"statement": <verbatim>, "reason": <one sentence> }]. Use "merges": [] when there are none. Each id may appear in at
most one merge.`;

const mergeSchema = Type.Object({
	merges: Type.Array(
		Type.Object({
			ids: Type.Array(Type.String(), { minItems: 2, maxItems: 2, description: "The two node ids that state the same claim." }),
			name: Type.String({ description: "The name of ONE of the two records, verbatim." }),
			statement: Type.String({ description: "The statement of that same record, verbatim." }),
			reason: Type.String({ description: "One sentence: why the two state the same claim." }),
		}),
		{ description: "Duplicate pairs. Pass [] when there are none — never omit the field." },
	),
});
export type MergeProposal = Static<typeof mergeSchema>["merges"][number];

export interface ReviewRecord {
	id: string;
	name: string;
	statement: string;
}

/** Records with their candidates, as one prompt. */
export function duplicatePrompt(batch: ReadonlyArray<{ record: ReviewRecord; candidates: ReviewRecord[] }>): string {
	const line = (r: ReviewRecord) => `${r.id} :: ${r.name}\n    statement: ${r.statement.replace(/\s+/g, " ")}`;
	return batch
		.map(({ record, candidates }) => `RECORD ${line(record)}\n  candidates:\n${candidates.map((c) => `  - ${line(c)}`).join("\n")}`)
		.join("\n\n");
}

/** A proposal is acceptable when both ids were shown together and the
 *  kept text is one record's own name + statement. */
export function checkMerges(
	merges: readonly MergeProposal[],
	shown: ReadonlyMap<string, ReviewRecord>,
	pairs: ReadonlySet<string>,
): string | null {
	const used = new Set<string>();
	for (const m of merges) {
		const [a, b] = m.ids as [string, string];
		const ra = shown.get(a);
		const rb = shown.get(b);
		if (!ra || !rb || a === b) return `Unknown or identical ids in merge ${a} + ${b}. Use ids from the records and their candidates.`;
		if (!pairs.has([a, b].sort().join("\u0000"))) return `${a} and ${b} were not shown as record and candidate. Merge only a record with one of its candidates.`;
		if (used.has(a) || used.has(b)) return `An id appears in more than one merge (${a} or ${b}). Each id may appear in at most one merge.`;
		used.add(a);
		used.add(b);
		const fromA = m.name === ra.name && m.statement === ra.statement;
		const fromB = m.name === rb.name && m.statement === rb.statement;
		if (!fromA && !fromB) return `The kept text of merge ${a} + ${b} must be the name AND statement of one of the two records, copied verbatim.`;
	}
	return null;
}

export function runDuplicateReview(opts: {
	engine: PiEngine | undefined;
	prompt: string;
	signal: AbortSignal | undefined;
	onStep: OnStep;
	validate: (merges: MergeProposal[]) => string | null;
}): Promise<MergeProposal[]> {
	return runSubmitAgent({
		role: "auditor",
		stage: "review-duplicates",
		chatId: "review",
		toolName: "submit_merges",
		toolDescription: "Submit the duplicate pairs (merges) — [] when there are none.",
		parameters: mergeSchema,
		fill: (raw: Static<typeof mergeSchema>) => raw.merges,
		systemPrompt: DUPLICATE_INSTRUCTIONS,
		prompt: opts.prompt,
		engine: opts.engine,
		signal: opts.signal,
		onStep: opts.onStep,
		neverSubmitted: "the duplicate review never submitted its merges",
		validate: opts.validate,
		prepareArguments: healArrays(["merges"]),
	});
}

// ─── 2. errors ──────────────────────────────────────────────────────────────

const ERROR_INSTRUCTIONS = `You check propositions of a knowledge graph for ERRORS. Each proposition has a short name (a label) and a
statement (the claim, at full precision). They were extracted by a model from one source — a lecture script, slides
or a tutoring chat — and may contain extraction mistakes.

How to check:
- If the source text is readable (read_source), look up the passage behind each proposition (search with a key
  term or formula, then read around the hit) and compare.
- If it is a chat, its transcript is included below.
- If no source is available, check against your own subject knowledge.

What counts as an error (fix it):
- a wrong formula, index, space, quantifier or condition — something that differs from the source;
- a statement that contradicts the source, or a claim that is false;
- extraction debris: self-corrections ("… Korrektur: …"), cut-off sentences, broken or raw LaTeX (e.g.
  "überline{λ}" or "\\overline{λ}" for λ̄);
- a name that does not match its statement.

What is NOT an error (leave it): style, wording you would phrase differently, a statement that is correct but less
complete than the source, notation that differs from the source but is correct and consistent.

Point at the error: copy the wrong passage verbatim from the name or statement into "wrong". If you cannot point at
a passage that is wrong, there is no error — leave the proposition.

How to fix: change as little as possible and keep the source's language and notation. Keep the proposition's
claim where it can be repaired. If the claim itself is false, rewrite it into the correct statement about the same
subject. Write formulas as the graph does: Unicode symbols, λ̄ for the conjugate of a single symbol, conj(…) for
the conjugate of a longer expression, closure(…) for a closure — never LaTeX commands.

Complete the task by CALLING submit_corrections with "corrections": [{ "id": <id>, "wrong": <the wrong passage,
verbatim>, "name"?: <new name>, "statement"?: <new statement>, "reason": <one sentence: what was wrong> }]. Give
only the fields you change. Use "corrections": [] when everything is correct.`;

const correctionSchema = Type.Object({
	corrections: Type.Array(
		Type.Object({
			id: Type.String({ description: "The proposition's id, verbatim." }),
			wrong: Type.String({ description: "The wrong passage, copied verbatim from the proposition's current name or statement." }),
			name: Type.Optional(Type.String({ description: "The corrected name — only when the name changes." })),
			statement: Type.Optional(Type.String({ description: "The corrected statement — only when the statement changes." })),
			reason: Type.String({ description: "One sentence: what was wrong." }),
		}),
		{ description: "Corrections. Pass [] when everything is correct — never omit the field." },
	),
});
export type CorrectionProposal = Static<typeof correctionSchema>["corrections"][number];

/** Occurrences of `needle` in `hay`, whitespace runs compared as one space. */
function occurrences(hay: string, needle: string): number {
	const h = hay.replace(/\s+/g, " ");
	const n = needle.replace(/\s+/g, " ").trim();
	if (!n) return 0;
	let count = 0;
	for (let at = h.indexOf(n); at >= 0; at = h.indexOf(n, at + n.length)) count++;
	return count;
}

/** The error review's submission, checked against the records it was shown
 *  (owner, 2026-11-11): every correction quotes its wrong passage verbatim
 *  from the current name or statement, and the corrected text no longer
 *  carries that passage as often — a "fix" of an error that is not in the
 *  text (the review once rewrote a correct ‖x‖_𝓗 to ‖x‖_𝓢 for a misread
 *  quantifier) is refused and retried. */
export function checkCorrections(
	corrections: readonly CorrectionProposal[],
	records: ReadonlyMap<string, { name: string; statement: string }>,
): string | null {
	const seen = new Set<string>();
	for (const c of corrections) {
		const record = records.get(c.id);
		if (!record) return `Unknown id ${c.id}. Correct only the propositions listed, ids verbatim.`;
		if (seen.has(c.id)) return `Proposition ${c.id} appears twice. Give one correction per proposition.`;
		seen.add(c.id);
		if (!c.name?.trim() && !c.statement?.trim()) return `Correction ${c.id} changes nothing. Give the corrected name and/or statement, or leave it out.`;
		if (!c.wrong?.trim()) return `Correction ${c.id} does not quote the wrong passage. Copy it verbatim into "wrong", or leave ${c.id} out.`;
		const before = occurrences(record.name, c.wrong) + occurrences(record.statement, c.wrong);
		if (before === 0)
			return `The passage "${c.wrong}" is not in the name or statement of ${c.id}. Quote the wrong passage verbatim — if nothing there is wrong, leave ${c.id} out.`;
		const name = c.name?.trim() ? c.name : record.name;
		const statement = c.statement?.trim() ? c.statement : record.statement;
		if (occurrences(name, c.wrong) + occurrences(statement, c.wrong) >= before)
			return `Correction ${c.id} still contains the passage "${c.wrong}" it quotes as wrong. Fix that passage, or leave ${c.id} out.`;
	}
	return null;
}

export function runErrorReview(opts: {
	engine: PiEngine | undefined;
	prompt: string;
	signal: AbortSignal | undefined;
	onStep: OnStep;
	tools: Record<string, AgentTool<any>>;
	validate: (corrections: CorrectionProposal[]) => string | null;
}): Promise<CorrectionProposal[]> {
	return runSubmitAgent({
		role: "auditor",
		stage: "review-errors",
		chatId: "review",
		toolName: "submit_corrections",
		toolDescription: "Submit the corrections — [] when everything is correct.",
		parameters: correctionSchema,
		fill: (raw: Static<typeof correctionSchema>) => raw.corrections,
		systemPrompt: ERROR_INSTRUCTIONS,
		prompt: opts.prompt,
		engine: opts.engine,
		signal: opts.signal,
		onStep: opts.onStep,
		neverSubmitted: "the error review never submitted its corrections",
		extraTools: opts.tools,
		maxTurns: 24,
		validate: opts.validate,
		prepareArguments: healArrays(["corrections"]),
	});
}

// ─── 3. chains ──────────────────────────────────────────────────────────────

const CHAIN_INSTRUCTIONS = `You check REASONING CHAINS of a knowledge graph. A chain says: its premises JOINTLY entail its conclusion — a
derivation, a special case of a general result, a definition or theorem applied to a concrete setting. Each chain is
listed with the full statements of its premises and its conclusion.

For each chain decide:
- CORRECT: the premises jointly entail the conclusion (standard steps of the subject may be left implicit). Leave it.
- REPAIRABLE: the conclusion does follow, but a needed premise is missing or a listed premise is irrelevant or
  wrong. Repair it with EXISTING nodes only — find them with find / list_propositions, copy ids verbatim. Never use
  the conclusion as its own premise.
- WRONG: the conclusion does not follow from any reasonable set of existing nodes, or the chain only links shared
  topic, vocabulary or analogy. Delete it.

When in doubt between correct and repairable, leave the chain as it is.

Complete the task by CALLING submit_chain_review with "repairs": [{ "chainId": <id>, "premises": [<ids>],
"reason": <one sentence> }] and "deletions": [{ "chainId": <id>, "reason": <one sentence> }]. Use empty lists when
every chain is correct.`;

const chainReviewSchema = Type.Object({
	repairs: Type.Array(
		Type.Object({
			chainId: Type.String({ description: "The chain's id (arg_…), verbatim." }),
			premises: Type.Array(Type.String(), { minItems: 1, description: "The repaired premises: existing node ids, verbatim." }),
			reason: Type.String({ description: "One sentence: what was missing or wrong." }),
		}),
		{ description: "Repaired chains. Pass [] when none — never omit the field." },
	),
	deletions: Type.Array(
		Type.Object({
			chainId: Type.String({ description: "The chain's id (arg_…), verbatim." }),
			reason: Type.String({ description: "One sentence: why the conclusion does not follow." }),
		}),
		{ description: "Chains to delete. Pass [] when none — never omit the field." },
	),
});
export type ChainVerdicts = Static<typeof chainReviewSchema>;

export function checkChainVerdicts(v: ChainVerdicts, chainIds: ReadonlySet<string>, nodeIds: ReadonlySet<string>): string | null {
	const seen = new Set<string>();
	for (const id of [...v.repairs.map((r) => r.chainId), ...v.deletions.map((d) => d.chainId)]) {
		if (!chainIds.has(id)) return `Unknown chain id ${id}. Use the chain ids listed, verbatim.`;
		if (seen.has(id)) return `Chain ${id} is both repaired and deleted, or appears twice. Give one verdict per chain.`;
		seen.add(id);
	}
	const unknown = [...new Set(v.repairs.flatMap((r) => r.premises))].filter((id) => !nodeIds.has(id));
	return unknown.length === 0 ? null : `Unknown node id(s) in repairs: ${unknown.join(", ")}. Copy ids verbatim from find / list_propositions.`;
}

export function runChainReview(opts: {
	engine: PiEngine | undefined;
	prompt: string;
	signal: AbortSignal | undefined;
	onStep: OnStep;
	tools: Record<string, AgentTool<any>>;
	validate: (v: ChainVerdicts) => string | null;
}): Promise<ChainVerdicts> {
	return runSubmitAgent({
		role: "auditor",
		stage: "review-chains",
		chatId: "review",
		toolName: "submit_chain_review",
		toolDescription: "Submit the chain verdicts (repairs, deletions) — empty lists when every chain is correct.",
		parameters: chainReviewSchema,
		fill: (raw: ChainVerdicts) => raw,
		systemPrompt: CHAIN_INSTRUCTIONS,
		prompt: opts.prompt,
		engine: opts.engine,
		signal: opts.signal,
		onStep: opts.onStep,
		neverSubmitted: "the chain review never submitted its verdicts",
		extraTools: opts.tools,
		maxTurns: 24,
		validate: opts.validate,
		prepareArguments: healArrays(["repairs", "deletions"]),
	});
}
