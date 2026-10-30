import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { getGraph, graphSessionIndex, graphSessionPropositions } from "../../core/graph.ts";
import { birthSessionOf } from "../../core/session-clusters.ts";
import type { ChatStore, GraphStore } from "../../core/ports.ts";
import { readTextSlice } from "./read.ts";

/**
 * THE PROBER'S GRAPH TOOLS (wave 7, owner-locked 2026-09-23): context
 * injection is dead — zero configuration beyond chat models. The prober
 * reads the learner's persistent knowledge map through two tools instead,
 * replacing the old injected block with on-demand eyes.
 *
 * Names + levels + dating ONLY — no statement text, no session contents
 * (owner ruling: the map's ORGANIZATION is the prober's business, its
 * prose is not). The data comes from Platform's pure core seams
 * (graphSessionIndex / graphSessionPropositions) over the same ports the
 * snapshot reads, so the prober and the learner's graph view can never
 * disagree.
 *
 * Registered on the prober ONLY when the settings gate opens
 * (graphToolsEnabled — the graph master switch AND the agent.graphTools
 * toggle); the composition root decides, the factory just receives the
 * store (absent = the gate is closed, no map tools — tests drive this).
 *
 * FORK (owner, 2026-10-30 — "what is the graph for, then?"): the map's
 * prose IS the tutor's business here. list_propositions carries each
 * proposition's statement and the chains concluding in the session,
 * search_graph finds propositions anywhere, and read_source reads the text
 * an import kept (config.sourceTextFile) — only sources that still have
 * propositions, the same set list_sessions shows. The prober, the teacher
 * and practice all get this set, behind the same gate.
 */

/** What the graph tools close over: the stores the session views read. */
export interface GraphToolContext {
	chatStore: ChatStore;
	graphStore: GraphStore;
}

const listSessionsInput = Type.Object({});

const listPropositionsInput = Type.Object({
	session: Type.String({
		minLength: 1,
		description: "The session's id exactly as list_sessions reported it (a chat id or a notes source id)",
	}),
});

/** What one tool answer may hold — the read tool's cap. */
const MAX_ANSWER_BYTES = 50 * 1024;
const MAX_HITS = 40;

/** Lines up to the byte cap, then one line saying what was left out. */
function capped(lines: string[], more: (left: number) => string): string[] {
	const out: string[] = [];
	let bytes = 0;
	for (const [i, line] of lines.entries()) {
		bytes += Buffer.byteLength(line, "utf-8") + 1;
		if (bytes > MAX_ANSWER_BYTES) {
			out.push(more(lines.length - i));
			break;
		}
		out.push(line);
	}
	return out;
}

const searchGraphInput = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "Glob pattern over proposition names, statements and phrasings — e.g. *trigger*. A bare term gets implicit surrounding *.",
	}),
});

const readSourceInput = Type.Object({
	source: Type.Optional(
		Type.String({ description: "The source's id (src_…) as read_source or list_sessions reported it. Omit to list the readable sources." }),
	),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	query: Type.Optional(
		Type.String({ minLength: 1, description: "Case-insensitive text to look for: returns the matching lines with line and page numbers instead of a slice." }),
	),
});

export function proberGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	const readSourceText = ctx.graphStore.readSourceText?.bind(ctx.graphStore);
	/** The imported sources whose text was kept AND that still have
	 *  propositions — deleting a source's nodes takes it off the shelf. */
	const readableSources = () =>
		graphSessionIndex(deps).flatMap((s) => {
			if (s.kind !== "file") return [];
			const text = readSourceText?.(s.id);
			return text === null || text === undefined ? [] : [{ id: s.id, name: s.name, text }];
		});
	return {
		list_sessions: {
			name: "list_sessions",
			label: "list_sessions",
			description:
				"List the sessions of the learner's persistent knowledge graph — every chat or imported-notes file that ever contributed a proposition, most recent first. The map is organized into birth-session clusters (propositions grouped by the session they were first learned in), and session names are those clusters' labels. " +
				"Each line: the session's name, kind (chat/file), how many propositions were born in it, its dates, and its id — use that id with list_propositions. " +
				"Reading this first shows what he has already covered and when, before you probe anything.",
			parameters: listSessionsInput,
			execute: serverExecute("list_sessions", listSessionsInput, async (): Promise<string> => {
				const sessions = graphSessionIndex(deps);
				if (sessions.length === 0) return "The knowledge graph is empty — no session has contributed propositions yet.";
				const lines = sessions.map((s, i) =>
					`${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? "" : "s"}, ` +
					`born ${s.createdAt ?? "unknown date"}${s.updatedAt ? `, last active ${s.updatedAt}` : ""}) — id: ${s.id}`,
				);
				return `${sessions.length} session(s) in the knowledge graph, most recent first:\n${lines.join("\n")}`;
			}),
		},
		list_propositions: {
			name: "list_propositions",
			label: "list_propositions",
			description:
				"List the propositions BORN in one knowledge-graph session — what was covered there — each with its full statement, " +
				"followed by the reasoning chains that conclude in this session (A ∧ B ⟹ C: the premises jointly imply the conclusion). " +
				"Covered is not understood: the map says what his material contained, your questions find out what he holds.",
			parameters: listPropositionsInput,
			execute: serverExecute("list_propositions", listPropositionsInput, async ({ session }): Promise<string> => {
				const propositions = graphSessionPropositions(deps, session);
				if (propositions.length === 0) {
					return `No propositions born in session "${session}". Call list_sessions for the current ids.`;
				}
				const graph = getGraph(deps.graphStore);
				const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
				const statementLines = propositions.map((p) => `- ${p.name} [${p.nodeId}]: ${nodes.get(p.nodeId)?.statement ?? "(no statement)"}`);
				// A chain lives where its CONCLUSION was born (the chain table's
				// rule); a chain with a vanished member is skipped.
				const chainLines = graph.chains
					.filter((c) => {
						const conclusion = nodes.get(c.conclusion);
						return conclusion && birthSessionOf(conclusion) === session && c.premises.every((p) => nodes.has(p));
					})
					.map((c) => `- ${c.premises.map((p) => nodes.get(p)!.name).join(" ∧ ")} ⟹ ${nodes.get(c.conclusion)!.name}`);
				const lines = [
					`${propositions.length} proposition(s) covered in this session:`,
					...statementLines,
					...(chainLines.length > 0 ? ["", `${chainLines.length} chain(s) concluding in this session:`, ...chainLines] : []),
				];
				return capped(lines, (left) => `[${left} more line(s) not shown — narrow with search_graph]`).join("\n");
			}),
		},
		search_graph: {
			name: "search_graph",
			label: "search_graph",
			description:
				"Search the whole knowledge graph for propositions — glob over names, statements and phrasings. " +
				`Returns up to ${MAX_HITS} matches, each with its name, id, the session it was born in, and its full statement.`,
			parameters: searchGraphInput,
			execute: serverExecute("search_graph", searchGraphInput, async ({ query }): Promise<string> => {
				const names = new Map(graphSessionIndex(deps).map((s) => [s.id, s.name]));
				const hits = getGraph(deps.graphStore).nodes.filter(
					(n) => globMatch(query, n.name) || globMatch(query, n.statement) || n.aliases.some((a) => globMatch(query, a)),
				);
				if (hits.length === 0) return `No proposition matches "${query}".`;
				const lines = hits.slice(0, MAX_HITS).map((n) => {
					const born = birthSessionOf(n);
					return `- ${n.name} [${n.id}]${born ? ` — from ${names.get(born) ?? born}` : ""}: ${n.statement}`;
				});
				const head = hits.length > MAX_HITS ? `${hits.length} matches, showing ${MAX_HITS} — narrow the query:` : `${hits.length} match(es):`;
				return capped([head, ...lines], (left) => `[${left} more match(es) not shown — narrow the query]`).join("\n");
			}),
		},
		...(readSourceText
			? {
				read_source: {
					name: "read_source",
					label: "read_source",
					description:
						"Read the text of a file he imported (lecture script, data sheet, manual) as the import read it — Markdown with " +
						"formulas as LaTeX when the doc loader read it, `--- Page N ---` markers where pages are known. " +
						"No arguments: list the readable sources. With `source`: read it like `read` (output truncated to 2000 lines or 50KB; " +
						"continue with offset). With `source` + `query`: the matching lines with their line and page numbers.",
					parameters: readSourceInput,
					execute: serverExecute("read_source", readSourceInput, async ({ source, offset, limit, query }): Promise<string> => {
						const sources = readableSources();
						if (!source) {
							if (sources.length === 0) return "No imported source is readable — nothing imported since texts are kept, or its propositions were deleted.";
							const lines = sources.map((s) => `- ${s.name} — id: ${s.id}, ${s.text.split("\n").length} lines`);
							return `${sources.length} readable source(s):\n${lines.join("\n")}`;
						}
						const hit = sources.find((s) => s.id === source);
						if (!hit) {
							return `Source "${source}" is not readable — it is not an imported source that still has propositions, or its text was not kept. Call read_source with no arguments for the readable ones.`;
						}
						if (query) return searchSourceText(hit.name, hit.text, query);
						return `${hit.name}\n\n${readTextSlice(hit.text, offset, limit)}`;
					}),
				},
			}
			: {}),
	};
}

/** The lines of a kept source text that contain `query`, with the page
 *  the nearest `--- Page N ---` marker above names. */
function searchSourceText(name: string, text: string, query: string): string {
	const needle = query.toLowerCase();
	const hits: string[] = [];
	let total = 0;
	let page: number | null = null;
	for (const [i, line] of text.split("\n").entries()) {
		const marker = /^--- Page (\d+) ---$/.exec(line.trim());
		if (marker) {
			page = Number(marker[1]);
			continue;
		}
		if (!line.toLowerCase().includes(needle)) continue;
		total++;
		if (hits.length < MAX_HITS) hits.push(`- line ${i + 1}${page !== null ? ` (page ${page})` : ""}: ${line.trim()}`);
	}
	if (total === 0) return `No line of ${name} contains "${query}".`;
	const head = total > MAX_HITS ? `${total} matching lines in ${name}, showing ${MAX_HITS}:` : `${total} matching line(s) in ${name}:`;
	return capped([head, ...hits], (left) => `[${left} more line(s) not shown]`).join("\n");
}

// ─── the auditor's graph tools (2026-09-27 relink) ───────────────────────────

/**
 * THE AUDITOR'S TOOLSET — the extraction auditor explores the graph to
 * place new propositions instead of receiving it injected (owner ruling
 * 2026-09-27: a full-graph dump bloats context as the graph grows; the
 * auditor looks up identity candidates itself). Auditor-specific
 * versions, deliberately different from the prober's:
 *
 *   find              glob over node names + statements + aliases — the
 *                     identity workhorse; returns id + name + statement
 *                     (statement text is ESSENTIAL for identity work,
 *                     unlike the prober's names-only rule).
 *   list_sessions     the birth-session index, no timestamps.
 *   list_propositions full proposition text (same reasoning as find).
 *
 * No timestamps anywhere: identity work needs content, not chronology.
 * Read-only, pure core seams, same ports the snapshot reads.
 */

/** Glob match — `*` spans anything, case-insensitive. `*needle*` is the
 *  expected shape; a bare term gets implicit surrounding stars. */
function globMatch(pattern: string, text: string): boolean {
	const raw = pattern.includes("*") ? pattern : `*${pattern}*`;
	const re = new RegExp(
		`^${raw.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "[\\s\\S]*" : `\\${ch}`))}$`,
		"i",
	);
	return re.test(text);
}

export function auditorGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	const findInput = Type.Object({
		query: Type.String({
			minLength: 1,
			description: "Glob pattern over node names, statements, and aliases — e.g. *will to power*. A bare term gets implicit surrounding *.",
		}),
	});
	return {
		find: {
			name: "find",
			label: "find",
			description:
				"Search the knowledge graph for existing propositions — glob over names, statements, and aliases. " +
				"Returns each match's id, name, full statement, and the session(s) it was born in (a list_propositions id). " +
				"This is how you decide whether a new proposition IS an existing one: search its key words, its synonyms, its phrasings.",
			parameters: findInput,
			execute: serverExecute("find", findInput, async ({ query }): Promise<string> => {
				const nodes = getGraph(deps.graphStore).nodes;
				const hits = nodes.filter(
					(n) => globMatch(query, n.name) || globMatch(query, n.statement) || n.aliases.some((a) => globMatch(query, a)),
				);
				if (hits.length === 0) return `No existing proposition matches "${query}".`;
				// BORN-IN POINTER (owner, 2026-09-29): a hit names its birth
				// session(s) — find results now compose with list_propositions
				// (read the whole session the hit came from) instead of being
				// dead ends. Legacy no-provenance nodes name none.
				const lines = hits.map((n) => {
					const born = [...new Set(n.provenance.map((pt) => pt.chatId))];
					return (
						`- ${n.id} :: ${n.name}\n  statement: ${n.statement}` +
						(born.length > 0 ? `\n  born in: ${born.join(", ")}` : "")
					);
				});
				return `${hits.length} match(es):\n${lines.join("\n")}`;
			}),
		},
		list_sessions: {
			name: "list_sessions",
			label: "list_sessions",
			description:
				"List the knowledge graph's birth sessions — every chat or imported-notes file that ever contributed a proposition. " +
				"Each line: name, kind, proposition count, id. Use the id with list_propositions to see what a session covered.",
			parameters: Type.Object({}),
			execute: serverExecute("list_sessions", Type.Object({}), async (): Promise<string> => {
				const sessions = graphSessionIndex(deps);
				if (sessions.length === 0) return "The knowledge graph is empty — no session has contributed propositions yet.";
				const lines = sessions.map((s, i) => `${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? "" : "s"}) — id: ${s.id}`);
				return `${sessions.length} session(s):\n${lines.join("\n")}`;
			}),
		},
		list_propositions: {
			name: "list_propositions",
			label: "list_propositions",
			description:
				"List the propositions BORN in one session, with FULL statement text — the content-level view for identity work " +
				"(deciding whether a new proposition is really one of these).",
			parameters: listPropositionsInput,
			execute: serverExecute("list_propositions", listPropositionsInput, async ({ session }): Promise<string> => {
				const propositions = graphSessionPropositions(deps, session);
				if (propositions.length === 0) return `No propositions born in session "${session}". Call list_sessions for the current ids.`;
				const nodes = new Map(getGraph(deps.graphStore).nodes.map((n) => [n.id, n]));
				const lines = propositions.map((p) => {
					const node = nodes.get(p.nodeId);
					return `- ${p.nodeId} :: ${p.name}\n  statement: ${node?.statement ?? "(unknown)"}`;
				});
				return `${propositions.length} proposition(s) born in this session:\n${lines.join("\n")}`;
			}),
		},
	};
}
