/**
 * The graph review's protocol and backup shapes (fork, owner 2026-11-10) —
 * pure types + guards, browser-safe (the review panel reads them through
 * the core barrel). The operations live in graph-review.ts (server side).
 */
import type { ExtractionRunUsage, GraphChain, GraphNode, Position } from "./contracts.ts";

/** What a review backup holds: the two ledgers it may change, and the
 *  layout. */
export interface ReviewBackup {
	nodes: GraphNode[];
	chains: GraphChain[];
	positions: Record<string, Position>;
}

// ─── the review protocol (graph/review.json) ────────────────────────────────

/** What a node looked like, as the protocol remembers it. */
export interface ReviewNodeText {
	id: string;
	name: string;
	statement: string;
}

/** One change the review made, with the model's one-sentence reason. */
export type ReviewEntry =
	| { kind: "merge"; survivor: string; removed: ReviewNodeText; before: ReviewNodeText; after: ReviewNodeText; reason: string }
	| { kind: "correct"; id: string; before: ReviewNodeText; after: ReviewNodeText; reason: string }
	| { kind: "chain-repair"; chainId: string; conclusion: string; before: string[]; after: string[]; reason: string }
	| { kind: "chain-delete"; chainId: string; premises: string[]; conclusion: string; reason: string }
	| { kind: "bridge"; chainId: string; premises: string[]; conclusion: string; reason: string };

export type ReviewPhase = "duplicates" | "errors" | "chains" | "bridges" | "layout";

export interface ReviewProtocol {
	startedAt: string;
	finishedAt?: string;
	status: "running" | "done" | "failed" | "undone";
	/** The phase running now (status running) or the last one reached. */
	phase?: ReviewPhase;
	entries: ReviewEntry[];
	/** sha256 of reviewFingerprintInput after the review — undo is allowed
	 *  only while the ledgers still hash to it. */
	fingerprint?: string;
	error?: string;
	/** Every review's usage so far (carried from protocol to protocol) —
	 *  the cost pill's "Review" stage; the auditor stage holds the steps. */
	usageLog?: ExtractionRunUsage[];
}

export function isReviewProtocol(value: unknown): value is ReviewProtocol {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.startedAt === "string" && typeof v.status === "string" && Array.isArray(v.entries);
}

export function isReviewBackup(value: unknown): value is ReviewBackup {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.nodes) && Array.isArray(v.chains) && typeof v.positions === "object" && v.positions !== null;
}
