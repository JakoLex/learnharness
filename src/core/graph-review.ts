/**
 * The graph review's ledger operations (fork, owner 2026-11-10) — pure
 * code over the storage ports, the discipline of graph-deletion.ts: no
 * LLM judgment here, every model verdict arrives as data and is checked
 * before it touches a ledger. Each operation is one synchronous block
 * (atomic vs the event loop) and rewrites only the ledgers it changed.
 *
 * Owner rulings (2026-11-10):
 *  - MERGE: the OLDER node (first in the nodes ledger) keeps its id; the
 *    model chooses the better name/statement for it, the other statement
 *    becomes a phrasing. The younger node's lines become link lines of the
 *    survivor (phrasings + provenance travel), its chains are rewired to
 *    the survivor; a chain that collapses (conclusion among its premises)
 *    dies.
 *  - CORRECT: name/statement of the node's create line are replaced; the
 *    old version is discarded (only the review protocol keeps it).
 *  - CHAINS: repaired with EXISTING nodes only, else deleted.
 */
import type { GraphChain, GraphNode } from "./contracts.ts";
import type { ReviewBackup } from "./review-protocol.ts";
import { deleteNodeTraces } from "./graph-deletion.ts";
import { getGraph } from "./graph.ts";
import type { GraphStore } from "./ports.ts";

export interface MergeResult {
	/** The id that stays (the older node). */
	survivor: string;
	/** The id that is gone (its lines now belong to the survivor). */
	removed: string;
	/** Chain lines whose members were rewired to the survivor. */
	chainsRewired: number;
	/** Chain lines that collapsed (conclusion among the premises) and died. */
	chainsDropped: number;
}

const firstIndex = (lines: readonly GraphNode[], id: string): number => lines.findIndex((line) => line.id === id);

/** One id per chain key (sorted premises + conclusion): when a rewrite
 *  makes two chains state the same argument, getGraph merges them by key,
 *  so their lines must share the first line's id — or deleting the chain
 *  by id would leave the other line standing. */
function normalizeChainIds(lines: GraphChain[]): GraphChain[] {
	const idOfKey = new Map<string, string>();
	return lines.map((line) => {
		const key = `${[...line.premises].sort().join("+")}>${line.conclusion}`;
		const id = idOfKey.get(key);
		if (id === undefined) {
			idOfKey.set(key, line.id);
			return line;
		}
		return id === line.id ? line : { ...line, id };
	});
}

/** Merge two nodes that state the same proposition. `name`/`statement` are
 *  the text the survivor carries from now on (the model's choice). Null
 *  when either id is unknown or both are the same. */
export function mergeNodes(
	graphStore: GraphStore,
	input: { ids: readonly [string, string]; name: string; statement: string },
): MergeResult | null {
	const [a, b] = input.ids;
	if (a === b || !input.name.trim() || !input.statement.trim()) return null;
	const lines = graphStore.readNodes();
	const ia = firstIndex(lines, a);
	const ib = firstIndex(lines, b);
	if (ia < 0 || ib < 0) return null;
	const [survivor, removed, createAt] = ia < ib ? [a, b, ia] : [b, a, ib];

	const outNodes = lines.map((line, i): GraphNode => {
		if (i === createAt) {
			const aliases = [...line.aliases];
			// The survivor's former statement stays as a phrasing unless it
			// is the chosen text itself.
			if (line.statement !== input.statement && !aliases.includes(line.statement)) aliases.push(line.statement);
			return { ...line, name: input.name, statement: input.statement, aliases: aliases.filter((x) => x !== input.statement) };
		}
		// Every line of the removed node becomes a link line of the
		// survivor: getGraph reads its statement and aliases as phrasings
		// and unions its provenance.
		return line.id === removed ? { ...line, id: survivor } : line;
	});

	let chainsRewired = 0;
	let chainsDropped = 0;
	const outChains: GraphChain[] = [];
	for (const line of graphStore.readChains()) {
		const touches = line.conclusion === removed || line.premises.includes(removed);
		if (!touches) {
			outChains.push(line);
			continue;
		}
		const conclusion = line.conclusion === removed ? survivor : line.conclusion;
		const premises = [...new Set(line.premises.map((p) => (p === removed ? survivor : p)))];
		if (premises.includes(conclusion)) {
			chainsDropped++;
			continue;
		}
		chainsRewired++;
		outChains.push({ ...line, premises, conclusion });
	}

	graphStore.rewriteLedgers({
		nodes: outNodes,
		...(chainsRewired + chainsDropped > 0 ? { chains: normalizeChainIds(outChains) } : {}),
	});
	const positions = graphStore.readPositions();
	if (positions[removed] !== undefined) {
		const { [removed]: _gone, ...rest } = positions;
		graphStore.writePositions(rest);
	}
	return { survivor, removed, chainsRewired, chainsDropped };
}

/** Replace a node's name and/or statement (its create line); the old text
 *  is discarded. Returns the text before the change, or null when the id
 *  is unknown or nothing would change. */
export function correctNode(
	graphStore: GraphStore,
	input: { id: string; name?: string; statement?: string },
): { name: string; statement: string } | null {
	const lines = graphStore.readNodes();
	const i = firstIndex(lines, input.id);
	if (i < 0) return null;
	const line = lines[i]!;
	const name = input.name?.trim() ? input.name : line.name;
	const statement = input.statement?.trim() ? input.statement : line.statement;
	if (name === line.name && statement === line.statement) return null;
	const out = [...lines];
	out[i] = { ...line, name, statement, aliases: line.aliases.filter((alias) => alias !== line.statement && alias !== statement) };
	graphStore.rewriteLedgers({ nodes: out });
	return { name: line.name, statement: line.statement };
}

/** Give a chain new premises — EXISTING nodes only, never its own
 *  conclusion. Returns the premises before the change, or null when the
 *  chain is unknown or the new premises are invalid. */
export function repairChain(
	graphStore: GraphStore,
	input: { chainId: string; premises: readonly string[] },
): string[] | null {
	const premises = [...new Set(input.premises)];
	if (premises.length === 0) return null;
	const live = new Set(getGraph(graphStore).nodes.map((node) => node.id));
	const lines = graphStore.readChains();
	const own = lines.filter((line) => line.id === input.chainId);
	if (own.length === 0) return null;
	const conclusion = own[0]!.conclusion;
	if (premises.includes(conclusion) || !premises.every((id) => live.has(id))) return null;
	const before = [...own[0]!.premises];
	graphStore.rewriteLedgers({
		chains: normalizeChainIds(lines.map((line) => (line.id === input.chainId ? { ...line, premises: [...premises] } : line))),
	});
	return before;
}

/** Remove a chain (all its assertion lines and its implication node's
 *  position). False when no such chain exists. */
export function deleteChain(graphStore: GraphStore, chainId: string): boolean {
	return chainId.startsWith("arg_") && deleteNodeTraces(graphStore, chainId) !== null;
}

export function snapshotForReview(graphStore: GraphStore): ReviewBackup {
	return { nodes: graphStore.readNodes(), chains: graphStore.readChains(), positions: graphStore.readPositions() };
}

export function restoreReviewBackup(graphStore: GraphStore, backup: ReviewBackup): void {
	graphStore.rewriteLedgers({ nodes: backup.nodes, chains: backup.chains });
	graphStore.writePositions(backup.positions);
}

/** The ledger content a review leaves behind, as one canonical string —
 *  the server hashes it; undo is allowed only while it is unchanged
 *  (positions excluded: the canvas commits layout after every review). */
export function reviewFingerprintInput(graphStore: Pick<GraphStore, "readNodes" | "readChains">): string {
	return JSON.stringify({ nodes: graphStore.readNodes(), chains: graphStore.readChains() });
}
