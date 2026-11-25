/**
 * SOURCE INCLUSION (fork, owner 2026-11-25): NotebookLM-style switches for
 * what the chat agents take into account. Per project, persisted in
 * graph/source-selection.json. Only what is switched OFF is stored, so a
 * new source (import, chat, book) is on until the learner switches it off.
 *
 * - A source is a Chains source: a chat or an imported notes file (its
 *   `src_…` id), keyed like graph provenance (`ProvenancePoint.chatId`).
 * - A book that is linked to an import (`BookRecord.sourceId`) has no
 *   switch of its own: it follows its import's switch, both ways.
 * - A proposition stays visible while ANY of its sources is on.
 *
 * The teacher, prober and practice agents read through these switches
 * (graph tools, book tools); graph maintenance (extraction, audit, bridges,
 * review) always sees everything. Pure and browser-safe.
 */

export interface SourceInclusion {
	version: 1;
	off: { sources: string[]; books: string[] };
}

export interface SourceInclusionChange {
	kind: "source" | "book";
	id: string;
	on: boolean;
}

/** The import a book is linked to, if any (the shared switch). */
export interface InclusionBook {
	id: string;
	sourceId?: string;
}

export function emptySourceInclusion(): SourceInclusion {
	return { version: 1, off: { sources: [], books: [] } };
}

const idList = (value: unknown, what: string): string[] => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)) {
		throw new Error(`Switched-off ${what} must be an array of ids.`);
	}
	return [...new Set(value as string[])].sort();
};

export function parseSourceInclusion(raw: unknown): SourceInclusion {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid source selection.");
	const r = raw as Record<string, unknown>;
	if (r.version !== 1) throw new Error("Unsupported source selection version.");
	const off = r.off;
	if (!off || typeof off !== "object" || Array.isArray(off)) throw new Error("Invalid source selection.");
	const o = off as Record<string, unknown>;
	return { version: 1, off: { sources: idList(o.sources, "sources"), books: idList(o.books, "books") } };
}

/** The POST body: `{changes: [{kind, id, on}]}`, at most 2000 changes. */
export function parseSourceInclusionChanges(raw: unknown): SourceInclusionChange[] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid source selection change.");
	const changes = (raw as Record<string, unknown>).changes;
	if (!Array.isArray(changes) || changes.length === 0 || changes.length > 2000) throw new Error("Name at least one source to switch.");
	return changes.map((c) => {
		if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("Invalid source selection change.");
		const { kind, id, on } = c as Record<string, unknown>;
		if (kind !== "source" && kind !== "book") throw new Error('A change\'s kind must be "source" or "book".');
		if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new Error("A change needs the source's or book's id.");
		if (typeof on !== "boolean") throw new Error("A change must say on: true or false.");
		return { kind, id, on };
	});
}

/** Apply switch changes. A linked book's change switches its import. */
export function applySourceInclusionChanges(
	state: SourceInclusion,
	changes: readonly SourceInclusionChange[],
	books: readonly InclusionBook[],
): SourceInclusion {
	const sources = new Set(state.off.sources);
	const offBooks = new Set(state.off.books);
	const linked = new Map(books.filter((b) => b.sourceId).map((b) => [b.id, b.sourceId!]));
	for (const change of changes) {
		const sourceId = change.kind === "source" ? change.id : linked.get(change.id);
		const set = sourceId !== undefined ? sources : offBooks;
		const id = sourceId ?? change.id;
		if (change.on) set.delete(id);
		else set.add(id);
	}
	return { version: 1, off: { sources: [...sources].sort(), books: [...offBooks].sort() } };
}

/** Drop ids that no longer exist (deleted sources/books): a re-import of
 *  the same path mints the same `src_…` id and must arrive switched on. */
export function withoutInclusionIds(state: SourceInclusion, ids: { sources?: Iterable<string>; books?: Iterable<string> }): SourceInclusion {
	const sources = new Set(ids.sources ?? []);
	const books = new Set(ids.books ?? []);
	return {
		version: 1,
		off: { sources: state.off.sources.filter((id) => !sources.has(id)), books: state.off.books.filter((id) => !books.has(id)) },
	};
}

/** Read access for the agents and views. */
export interface SourceSwitches {
	sourceOn(id: string): boolean;
	bookOn(book: InclusionBook): boolean;
	/** On while ANY of its sources is on (owner, 2026-11-25). No
	 *  provenance at all counts as on. */
	nodeOn(node: { provenance: ReadonlyArray<{ chatId: string }> }): boolean;
}

export function sourceSwitches(state: SourceInclusion): SourceSwitches {
	const offSources = new Set(state.off.sources);
	const offBooks = new Set(state.off.books);
	const sourceOn = (id: string) => !offSources.has(id);
	return {
		sourceOn,
		bookOn: (book) => (book.sourceId ? sourceOn(book.sourceId) : !offBooks.has(book.id)),
		nodeOn: (node) => node.provenance.length === 0 || node.provenance.some((p) => sourceOn(p.chatId)),
	};
}

/** Everything on — the default when nothing is stored, and for callers
 *  that do not filter. */
export const ALL_SOURCES_ON: SourceSwitches = sourceSwitches(emptySourceInclusion());

/** The line under a source list or an empty result (owner: count only,
 *  never names or content). Empty string when nothing is off. */
export function switchedOffNote(count: number, noun: "source" | "book"): string {
	if (count <= 0) return "";
	return `(${count} ${noun}${count === 1 ? " is" : "s are"} switched off by the learner.)`;
}

/** The name an import and a book are matched by (owner, 2026-11-25): the
 *  file name without folders and extension, case-insensitive. */
export function bookLinkKey(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? name;
	return base.replace(/\.[^.]+$/, "").trim().toLocaleLowerCase();
}
