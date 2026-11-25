"use client";

/**
 * THE CHAIN TABLE (chains overlay; owner refinements round 2, 2026-09-29):
 * every reasoning chain of the graph in one FULL-BLEED surface — the blur
 * + translucent background IS the surface, no inner card. The top bar is
 * THE shared TopBar (standardization ruling: one element, every surface —
 * h-15, lh-drag with carve-outs, select-none, sidebar reopen, traffic-
 * light gutter; born from this overlay's hand-rolled bar breaking every
 * rule at once). The overlay (z-40) covers home's floating header while
 * open, so the TopBar's own SidebarToggle is the reopen path.
 *
 * HIERARCHY (three levels, one click each): CLUSTER (the birth session —
 * a chat or a notes file; a chain lives where its CONCLUSION was born,
 * owner ruling) → REASONING CHAIN → PROPOSITION STATEMENTS. Expanding a
 * chain reveals its members' statement text directly — names live in the
 * chain line, never twice; a singleton reveals its one statement in one
 * click. Everything starts collapsed. PROMINENT indentation carries the
 * structure (owner ruling: chains deep under folders, statements deeper)
 * — the ONLY lines are the horizontal separators between cluster groups
 * (vertical column hairlines removed with them, owner ruling: "anything
 * else is better without them").
 *
 * THE CHAIN LINE: every proposition name is a faint-outlined CHIP
 * with the LOGIC as the connectives (owner rulings, 2026-09-30):
 * premises join with the LaTeX LAND (∧) and the conclusion separates
 * by the LaTeX IMPLICATION (⟹) — `A ∧ B ⟹ C`, never the misleading
 * `A → B → C`. The glyphs are REAL KaTeX renders (components/
 * latex-glyph.tsx — the app's math engine, never SVGs), PROMINENT in
 * the theme foreground (white), not dim gray. A lonely chip (no
 * premises) carries no glyph — it reads as a standalone proposition;
 * "(no premises)" survives only as the row's aria-label.
 *
 * SORTING: all three columns sortable (owner ruling — "consistency is
 * key"): Name (A→Z), Props (largest-first), Created (newest-first);
 * click toggles asc/desc; a SMALL chevron marks the active header. Sort
 * orders cluster rows AND chains within.
 *
 * SELECTION never shifts layout (owner ruling): a floating bottom bar —
 * the Google-Photos pattern — appears only when something is selected,
 * showing the agents' ACTUAL input (chainsForSelection over the flat
 * node-id selection: a premise without its conclusion counts as the
 * singleton it becomes) + Clear — in practice picking.
 *
 * SOURCE SWITCHES (fork, owner 2026-11-25): outside practice picking the
 * source and folder checks are the chat agents' switches, NotebookLM
 * style — checked = the tutor takes it into account, everything starts
 * on (core/source-inclusion.ts). An import linked to a book on the shelf
 * shows the library icon; they share one switch. DELETE (owner,
 * 2026-09-29 night: "this is really the view deletion should be done
 * in") moved from the checkbox selection into each source and folder
 * row's "⋯" menu; it opens the SAME confirm dialog, which also offers
 * the linked books. The overlay stays the graph's MANAGEMENT surface. The fuzzy
 * search (names, aliases, statements) filters chains grouped +
 * auto-expanded under their clusters (non-matching clusters hide; the
 * collapsed view returns on clear).
 *
 * Read-only toward the graph.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	BookIcon,
	BookOpenIcon,
	FolderPlusIcon,
	LibraryBigIcon,
	ListTreeIcon,
	SearchIcon,
	XIcon,
} from "lucide-react";
import { chainsForSelection, chainSourceDirectory, folderEntries, formatChainLine, fuzzyScore, sourceFileLabel } from "@/src/core";
import type { GraphChain, GraphNode, SourceDirectory, SourceEntry, SourceFolder } from "@/src/core";
import { RowMenu } from "./row-menu";
import { EditableSourceName, SourceDragRow, sourceNameMatches, SourceFolderTree, type OrganizationChange } from "./source-folder-tree";
import { chainRow, useChainNavigation } from "./chain-navigation";
import { useServerEvent, useServerResync } from "./server-events";
import { apiFetch } from "@/components/api-fetch";
import { TopBar } from "@/components/top-bar";
import { InteractionLayerOwner, useInteractionLayer } from "./interaction-layers";
import { DeleteSourceDialog } from "@/components/delete-source-dialog";
import { LatexGlyph } from "@/components/latex-glyph";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { TreeCell, TreeCheckbox, TreeDisclosure, TreeGuide, TreeHeader, TreeSelectionSpacer, TreeSeparator, treeBranchLayout, treeColumnLayout, treeRowLayout } from "./tree-presentation";

/** The sortable columns (owner ruling: all three — consistency). */
export type ChainSortCol = "name" | "props" | "created";
export interface ChainSort {
	col: ChainSortCol;
	/** 1 = ascending (A→Z, oldest-first, smallest-first), -1 = descending. */
	dir: 1 | -1;
}

/** A cluster's chains share the conclusion's birth (owner ruling). This
 *  record is assembled per render from the visible chains. */
interface ClusterGroup {
	key: string;
	birth: string | null;
	label: string | null;
	kind: "chat" | "notes" | null;
	chains: ReturnType<typeof chainsForSelection>;
	nodeIds: string[];
	newestCreatedAt: string;
}

/** The table's pure body — exported for SSR pins (the render-suite
 *  discipline). All state (query, sort, selection, expansion) arrives
 *  via props; the overlay wrapper below owns it. */
export function ChainTableBody({
	nodes,
	chains: storedChains,
	sessions,
	fileSources,
	query,
	onQuery,
	sort,
	onSort,
	selection,
	expandedClusters,
	expandedChains,
	onToggleCluster,
	onToggleChain,
	onToggleNodes,
	onClear,
	onClose,
	selectMode,
	onSelect,
	directory: fullDirectory,
	onOrganizationChange,
	selectedFolders = new Set<string>(),
	sourceOn = () => true,
	linkedBooks = {},
	onDeleteEntry,
	onToggleSource = () => {},
	onToggleFolder = () => {},
	keyboardActive = true,
	sourceInventoryPending = false,
	pickerChrome = false,
}: {
	sourceInventoryPending?: boolean;
	pickerChrome?: boolean;
	keyboardActive?: boolean;
	directory?: SourceDirectory;
	onOrganizationChange?: OrganizationChange;
	selectedFolders?: ReadonlySet<string>;
	/** Fork (owner, 2026-11-25): outside practice picking, the source and
	 *  folder checks are the chat agents' switches — checked = the tutor
	 *  takes the source into account (core/source-inclusion.ts). */
	sourceOn?: (id: string) => boolean;
	/** import id → its linked book on the shelf (one switch for both). */
	linkedBooks?: Readonly<Record<string, { book: string; title: string }>>;
	/** The rows' "⋯" menu → Delete (Delete left the checkbox selection). */
	onDeleteEntry?: (kind: "source" | "folder", id: string) => void;
	onToggleSource?: (id: string, next: boolean) => void;
	onToggleFolder?: (id: string, next: boolean) => void;
	nodes: GraphNode[];
	chains: GraphChain[];
	sessions: Record<string, string>;
	fileSources: Record<string, string>;
	query: string;
	onQuery: (v: string) => void;
	sort: ChainSort;
	onSort: (col: ChainSortCol) => void;
	selection: ReadonlySet<string>;
	expandedClusters: ReadonlySet<string>;
	expandedChains: ReadonlySet<string>;
	onToggleCluster: (key: string) => void;
	onToggleChain: (id: string) => void;
	/** Selection is ALWAYS a flat node-id set — cluster, chain, and single
	 *  proposition checks all reduce to this. */
	onToggleNodes: (ids: string[], next: boolean) => void;
	onClear: () => void;
	onClose: () => void;
	/** PRACTICE SELECT (2026-10-04): the floating bar's confirm becomes
	 *  "Practice these" — no delete fence; the caller owns what the
	 *  selection becomes. */
	selectMode?: boolean;
	onSelect?: () => void;
}) {
	const [creatingFolder, setCreatingFolder] = useState(false);
	const tableRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const navigation = useChainNavigation(tableRef, searchRef, keyboardActive);
	// Searches still expand sources/folders by default, but explicit keyboard
	// or pointer collapses remain effective until the search changes.
	const [searchFolds, setSearchFolds] = useState({ query, ids: new Set<string>() });
	useEffect(() => { setSearchFolds({ query, ids: new Set() }); }, [query]);
	const foldedClusters = searchFolds.query === query ? searchFolds.ids : new Set<string>();
	const toggleCluster = (id: string) => {
		if (!query.trim()) { onToggleCluster(id); return; }
		setSearchFolds((previous) => {
			const ids = new Set(previous.query === query ? previous.ids : []);
			if (ids.has(id)) ids.delete(id); else ids.add(id);
			return { query, ids };
		});
	};
	const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
	const directory = useMemo(() => fullDirectory && chainSourceDirectory(fullDirectory), [fullDirectory]);
	const hiddenSourceIds = useMemo(() => new Set(fullDirectory?.sources.filter((s) => s.chatKind === "practice").map((s) => s.id)), [fullDirectory]);
	const sourceRecords = useMemo(() => new Map(directory?.sources.map((s) => [s.id, s])), [directory]);
	const matchesSource = useCallback((birth: string) => sourceNameMatches(directory, birth,
		sourceRecords.get(birth)?.label ?? sessions[birth] ?? (fileSources[birth] === undefined ? null : sourceFileLabel(fileSources[birth])), query),
	[directory, sourceRecords, sessions, fileSources, query]);
	const chains = useMemo(() => chainsForSelection(nodes, storedChains), [nodes, storedChains]);
	// Filter source groups, not global nodes: shared premises remain visible
	// in teaching/notes groups. Keep the graph-wide header and pick set intact.
	const sourceChains = useMemo(() => chains.filter((chain) =>
		!hiddenSourceIds.has(byId.get(chain.conclusion)?.provenance[0]?.chatId ?? "")), [chains, byId, hiddenSourceIds]);
	const searching = query.trim() !== "";
	const allSourceNodes = useMemo(() => {
		const membership = new Map<string, Set<string>>();
		for (const chain of sourceChains) {
			const birth = byId.get(chain.conclusion)?.provenance[0]?.chatId;
			if (!birth) continue;
			const members = membership.get(birth) ?? new Set<string>();
			for (const id of [...chain.premises, chain.conclusion]) members.add(id);
			membership.set(birth, members);
		}
		return membership;
	}, [sourceChains, byId]);

	// The fuzzy filter: a chain is visible when ANY member matches on
	// name, aliases, or statement; chains rank by best member score.
	const visibleChains = useMemo(() => {
		if (!searching) return sourceChains;
		const scored = sourceChains
			.map((chain) => {
				const birth = byId.get(chain.conclusion)?.provenance[0]?.chatId;
				let best: number | null = birth && matchesSource(birth) ? 0 : null;
				for (const id of [...chain.premises, chain.conclusion]) {
					const node = byId.get(id);
					if (!node) continue;
					const s = fuzzyScore(query, node.name, node.statement, ...node.aliases);
					if (s === null) continue;
					if (best === null || s > best) best = s;
				}
				return best === null ? null : { chain, best };
			})
			.filter((r): r is { chain: (typeof chains)[number]; best: number } => r !== null);
		return scored
			.sort((a, b) => b.best - a.best || (a.chain.id < b.chain.id ? -1 : 1))
			.map(({ chain }) => chain);
	}, [sourceChains, byId, query, searching, matchesSource]);

	// Group the visible chains by their CONCLUSION's birth (owner ruling).
	// Unlabeled births (provenance gone / never named) form one honest
	// muted group, sorted last under name-sort.
	const groups = useMemo(() => {
		// Session kinds must arrive before provenance-only source rows can render.
		if (sourceInventoryPending) return [];
		const map = new Map<string, ClusterGroup>();
		for (const source of directory?.sources ?? []) {
			if (searching && !matchesSource(source.id)) continue;
			map.set(source.id, { key: source.id, birth: source.id, label: source.label,
				kind: source.kind === "missing" ? null : source.kind, chains: [], nodeIds: [], newestCreatedAt: "" });
		}
		for (const chain of visibleChains) {
			const conclusion = byId.get(chain.conclusion);
			const birth = conclusion?.provenance[0]?.chatId ?? null;
			const key = birth ?? "\0unlabeled";
			let group = map.get(key);
			if (!group) {
				const label = birth === null ? null : (sourceRecords.get(birth)?.label ?? sessions[birth] ?? (fileSources[birth] === undefined ? null : sourceFileLabel(fileSources[birth])));
				const kind =
					birth === null ? null : sessions[birth] !== undefined ? "chat" : fileSources[birth] !== undefined ? "notes" : null;
				group = { key, birth, label, kind, chains: [], nodeIds: [], newestCreatedAt: "" };
				map.set(key, group);
			}
			group.chains.push(chain);
			for (const id of [...chain.premises, chain.conclusion]) {
				if (!group.nodeIds.includes(id)) group.nodeIds.push(id);
				const createdAt = byId.get(id)?.createdAt ?? "";
				if (createdAt > group.newestCreatedAt) group.newestCreatedAt = createdAt;
			}
		}
		const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
		const list = [...map.values()];
		// Existing graph groups retain their newest-member date. Inventory-only
		// rows fall back to record dates; a re-import must not redraft old dates.
		for (const group of list) if (!group.newestCreatedAt && group.birth) group.newestCreatedAt = sourceRecords.get(group.birth)?.createdAt ?? "";
		// Sort law (owner ruling: all three columns sortable — consistency):
		// the active column orders BOTH cluster rows and chains within; name
		// is the universal tiebreak (asc). Unlabeled clusters sort last under
		// name-sort (￿ sentinel).
		const nameKey = (g: ClusterGroup) => g.label ?? "\uffff";
		const cmpName = (a: ClusterGroup, b: ClusterGroup) => collator.compare(nameKey(a), nameKey(b)) * (sort.col === "name" ? sort.dir : 1);
		const cmpProps = (a: ClusterGroup, b: ClusterGroup) =>
			sort.dir === -1 ? b.nodeIds.length - a.nodeIds.length : a.nodeIds.length - b.nodeIds.length;
		const cmpCreated = (a: ClusterGroup, b: ClusterGroup) =>
			sort.dir === -1 ? b.newestCreatedAt.localeCompare(a.newestCreatedAt) : a.newestCreatedAt.localeCompare(b.newestCreatedAt);
		list.sort((a, b) =>
			sort.col === "created" ? cmpCreated(a, b) || cmpName(a, b) : sort.col === "props" ? cmpProps(a, b) || cmpName(a, b) : cmpName(a, b),
		);
		for (const group of list) {
			const chainName = (chain: (typeof chains)[number]) => byId.get(chain.conclusion)?.name ?? chain.conclusion;
			const chainSize = (chain: (typeof chains)[number]) => chain.premises.length + 1;
			const chainDate = (chain: (typeof chains)[number]) => byId.get(chain.conclusion)?.createdAt ?? "";
			const cName = (a: (typeof chains)[number], b: (typeof chains)[number]) => collator.compare(chainName(a), chainName(b)) * (sort.col === "name" ? sort.dir : 1);
			const cProps = (a: (typeof chains)[number], b: (typeof chains)[number]) =>
				sort.dir === -1 ? chainSize(b) - chainSize(a) : chainSize(a) - chainSize(b);
			const cDate = (a: (typeof chains)[number], b: (typeof chains)[number]) =>
				sort.dir === -1 ? chainDate(b).localeCompare(chainDate(a)) : chainDate(a).localeCompare(chainDate(b));
			group.chains.sort((a, b) =>
				sort.col === "created" ? cDate(a, b) || cName(a, b) : sort.col === "props" ? cProps(a, b) || cName(a, b) : cName(a, b),
			);
		}
		return list;
	}, [visibleChains, byId, sessions, fileSources, sort, directory, sourceRecords, searching, matchesSource, sourceInventoryPending]);

	// The derived shape under the floating bar (the agents' ACTUAL input).
	const derived = useMemo(() => {
		const selectedNodes = [...selection].map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined);
		return chainsForSelection(selectedNodes, storedChains);
	}, [selection, byId, storedChains]);

	const nameOf = (id: string) => byId.get(id)?.name ?? id;
	const dateOf = (id: string) => byId.get(id)?.createdAt.slice(0, 10) ?? "";
	const dirIcon = (col: ChainSortCol) =>
		sort.col !== col ? null : sort.dir === 1 ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />;

	return (
		<div ref={tableRef} tabIndex={-1} data-testid="chain-table" className="relative flex h-full min-h-0 flex-col outline-none [&_[data-chain-nav-active=true]]:bg-accent/50 [&_[data-chain-nav-row]]:outline-none [&_[data-chain-nav-row]]:scroll-mt-8 [&_[data-chain-nav-row]]:scroll-mb-16">
			{/* THE shared top bar (standardization ruling): drag mechanics,
			    sidebar reopen, traffic-light gutter — the same element as every
			    chat surface. NO TITLE (owner round 11, 2026-10-05): the serif
			    title register is RESERVED — it always names a session; the
			    chain table names nothing, so its bar carries counts + search +
			    close only. Search + close carve out with lh-no-drag (the mask
			    law: later in the DOM). */}
			<TopBar sidebarToggle={!pickerChrome}>
				<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
					{chains.length} {chains.length === 1 ? "chain" : "chains"} · {nodes.length} {nodes.length === 1 ? "node" : "nodes"}
				</span>
				{onOrganizationChange && <button type="button" aria-label="Add folder" data-testid="add-source-folder"
					onClick={() => setCreatingFolder(true)} className="lh-no-drag rounded-lg p-2 text-muted-foreground hover:bg-accent"><FolderPlusIcon className="size-4" /></button>}
				<div className="relative shrink-0">
					<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						ref={searchRef}
						value={query}
						data-testid="chain-table-search"
						onChange={(e) => onQuery(e.target.value)}
						placeholder="Search nodes…"
						aria-label="Search nodes"
						spellCheck={false}
						className="lh-no-drag h-8 w-56 rounded-lg border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
					/>
				</div>
			<button
					type="button"
					data-testid="chain-table-close"
					onClick={onClose}
					aria-label="Close chains"
					className="lh-no-drag flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</TopBar>

			{/* The list: NO per-row lines (owner ruling) — the ONLY horizontal
			    separators sit between cluster groups; the ALIGNMENT STAIRCASE
			    carries the hierarchy (owner round 4, "double the indentation":
			    two-column steps — chains pl-12 aligned with the folder icon,
			    statements pl-21 where a chain icon would sit).
			    All three columns sort, small chevron on active. */}
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{/* The TOP rule (owner round 5: the table is framed — a line under
			    the header, a line under the last group, lines between groups). */}
				<TreeHeader sticky>
					<button
						type="button"
						data-testid="sort-name"
						onClick={() => onSort("name")}
						aria-sort={sort.col === "name" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
						{...treeColumnLayout({ grow: true, align: "left", className: "flex items-center gap-1 transition-colors hover:text-foreground" })}
					>
						Name {dirIcon("name")}
					</button>
					<button
						type="button"
						data-testid="sort-props"
						onClick={() => onSort("props")}
						aria-sort={sort.col === "props" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
						{...treeColumnLayout({ widthClassName: "w-14", align: "right", className: "flex items-center justify-end gap-1 transition-colors hover:text-foreground" })}
					>
						Props {dirIcon("props")}
					</button>
					<button
						type="button"
						data-testid="sort-created"
						onClick={() => onSort("created")}
						aria-sort={sort.col === "created" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
						{...treeColumnLayout({ widthClassName: "w-20", align: "right", className: "flex items-center justify-end gap-1 transition-colors hover:text-foreground" })}
					>
						Created {dirIcon("created")}
					</button>
				</TreeHeader>

				{creatingFolder && onOrganizationChange && <div className="flex items-center px-3 py-2" data-testid="new-folder-row">
					<EditableSourceName name="" initiallyEditing onCancel={() => setCreatingFolder(false)}
						onSave={async (name) => {
						const id = await onOrganizationChange({ action: "create-folder", name, parentId: null });
						onQuery(""); if (id) navigation.focusRow(["folder", id]); setCreatingFolder(false);
					}} />
				</div>}
				{groups.length === 0 && (directory?.organization.folders.length ?? 0) === 0 && (
					<div data-testid="chain-table-nomatch" className="px-4 pt-3 text-xs text-muted-foreground">
						No matching chains.
					</div>
				)}

				<SourceFolderTree groups={groups} directory={directory} query={query} sort={sort} onAction={onOrganizationChange}
					inclusion={selectMode ? undefined : { sourceOn }}
					onDeleteFolder={!selectMode && onDeleteEntry ? (id) => onDeleteEntry("folder", id) : undefined}
					expanded={expandedClusters} collapsedForSearch={foldedClusters} onToggleExpanded={toggleCluster} selection={selection} selectedFolders={selectedFolders}
					onToggleNodes={onToggleNodes} onToggleFolder={onToggleFolder} allowEmptySelection={!selectMode} allSourceNodes={allSourceNodes}
					renderSource={(group, depth) => {
					const open = searching ? !foldedClusters.has(group.key) : expandedClusters.has(group.key);
					const selectedCount = group.nodeIds.filter((id) => selection.has(id)).length;
					const empty = group.birth === null ? group.nodeIds.length === 0 : !allSourceNodes.get(group.birth)?.size;
					const linkedBook = group.birth ? linkedBooks[group.birth] : undefined;
					return (
						<div
							key={group.key}
							data-testid={`cluster-group-${group.key}`}
							// The horizontal rules (owner rulings, rounds 2 + 5): between
							// cluster groups AND under the last one — the table is framed
							// top (header) and bottom. Never on individual rows.
							{...treeBranchLayout({ depth, className: "border-b border-transparent", style: { marginLeft: depth * 36 } })}
						>
							{/* The TREE THREAD (owner rounds 5–6): a vertical guide at the
							    expander arrow's column (center 37px: pl-3 + checkbox 14 +
							    gap 4 + half the 14px expander), BRACKETED by checkbox
							    bottom edges — it starts at the cluster row's own checkbox
							    bottom (top-[23px], leaving the arrow's stroke a visible
							    gap, live-measured) and terminates exactly at the LAST
							    checkbox bottom (bottom-[8px] = 9px from the border box minus the 1px group rule, measured). */}
							{open && group.chains.length > 0 && (
								<TreeGuide selectionColumn depth={0} data-testid={`cluster-thread-${group.key}`} />
							)}
							{/* The cluster row: birth-session group header. */}
							<SourceDragRow {...chainRow(["source", group.key], depth, open)} kind="source" id={group.key} name={group.label ?? "unlabeled"} enabled={Boolean(onOrganizationChange && group.birth)} {...treeRowLayout()}>
								<RowCheckbox
									disabled={selectMode ? group.nodeIds.length === 0 : !directory?.sources.some((s) => s.id === group.birth)}
									checked={selectMode ? selectedCount === group.nodeIds.length && group.nodeIds.length > 0 : group.birth !== null && sourceOn(group.birth)}
									indeterminate={selectMode ? selectedCount > 0 && selectedCount < group.nodeIds.length : false}
									onToggle={(next) => { if (selectMode) onToggleNodes(group.nodeIds, next); else if (group.birth) onToggleSource(group.birth, next); }}
									testid={`cluster-checkbox-${group.key}`}
									label={selectMode ? `Select everything born in ${group.label ?? "unlabeled"}` : `Include ${group.label ?? "unlabeled"} for the tutor`}
								/>
								<Expander open={open} onClick={() => toggleCluster(group.key)} testid={`cluster-toggle-${group.key}`} label={`Expand cluster ${group.label ?? "unlabeled"}`} />
								<button type="button" data-source-icon data-testid={`source-icon-${group.key}`} aria-expanded={open} aria-label={`Expand source ${group.label ?? "unlabeled"}`}
									onClick={() => toggleCluster(group.key)} className={`flex h-5 w-3.5 shrink-0 items-center justify-center rounded ${empty ? "text-muted-foreground/60" : "text-muted-foreground"} transition-colors hover:bg-accent hover:text-foreground`}>
									{open ? <BookOpenIcon className="size-3.5 shrink-0" /> : <BookIcon className="size-3.5 shrink-0" />}
								</button>
								{onOrganizationChange && group.birth && group.kind !== null
									? <EditableSourceName name={group.label ?? ""} muted={empty} onSave={(name) => onOrganizationChange({ action: "rename-source", id: group.birth!, name })} />
									: <span className={`min-w-0 flex-1 truncate text-sm font-medium${empty ? " text-muted-foreground/60" : ""}`}>{group.label ?? <span className="text-muted-foreground/60">unlabeled</span>}</span>}
								{group.kind === "notes" && <span className="text-[11px] uppercase tracking-widest text-muted-foreground/60">notes</span>}
								{linkedBook && (
									<span data-testid={`source-book-${group.key}`} title={`Also on the bookshelf as “${linkedBook.title}” — one switch for both`}
										aria-label={`Linked to the book ${linkedBook.title}`} className="flex shrink-0 text-muted-foreground/70">
										<LibraryBigIcon className="size-3.5" />
									</span>
								)}
								{!selectMode && onDeleteEntry && group.birth && directory?.sources.some((s) => s.id === group.birth) && (
									<RowMenu label={`More for ${group.label ?? "unlabeled"}`} testid={`source-menu-${group.key}`}
										items={[{ label: "Delete…", testid: `source-delete-${group.key}`, destructive: true, onSelect: () => onDeleteEntry("source", group.birth!) }]} />
								)}
								<TreeCell widthClassName="w-14" align="right" className="text-xs tabular-nums text-muted-foreground">
									{group.nodeIds.length}
								</TreeCell>
								<TreeCell widthClassName="w-20" align="right" className="text-xs tabular-nums text-muted-foreground">
									{group.newestCreatedAt.slice(0, 10)}
								</TreeCell>
							</SourceDragRow>

							{/* The chain rows — clearly indented under the folder
							    (owner ruling); visible only when the cluster is open
							    (searching auto-expands). */}
							{open &&
								group.chains.map((chain) => {
									const memberIds = [...chain.premises, chain.conclusion];
									const chainOpen = expandedChains.has(chain.id);
									const selectedInChain = memberIds.filter((id) => selection.has(id)).length;
									return (
										<div key={chain.id} data-testid={`chain-block-${chain.id}`} {...treeBranchLayout()}>
												{/* The chain's own thread (owner rounds 5–6): the same
												    bracket law one level down — at the chain arrow's column
												    (center 73px), from the chain row's checkbox bottom
												    (top-[22px]) to the LAST statement row's checkbox bottom
												    (bottom-[8px]) — live-measured anchors. */}
												{chainOpen && memberIds.length > 0 && (
													<TreeGuide selectionColumn depth={1} variant="compact" data-testid={`chain-thread-${chain.id}`} />
												)}
											<div
												{...chainRow(["chain", group.key, chain.id], depth + 1, chainOpen)}
												data-testid={`chain-row-${chain.id}`}
												aria-label={formatChainLine(chain, Object.fromEntries([...byId.entries()].map(([id, n]) => [id, { name: n.name }])))}
												{...treeRowLayout({ depth: 1, variant: "compact" })}
											>
												{selectMode ? <RowCheckbox
													checked={selectedInChain === memberIds.length && memberIds.length > 0}
													indeterminate={selectedInChain > 0 && selectedInChain < memberIds.length}
													onToggle={(next) => onToggleNodes(memberIds, next)}
													testid={`chain-checkbox-${chain.id}`}
													label={`Select chain ${nameOf(chain.conclusion)}`}
												/> : <TreeSelectionSpacer />}
												<Expander open={chainOpen} onClick={() => onToggleChain(chain.id)} testid={`chain-toggle-${chain.id}`} label={`Expand chain ${nameOf(chain.conclusion)}`} />
												{/* The chain line: proposition names as faint-outlined
												    chips. THE LOGIC IS THE PAYLOAD (owner rulings,
												    2026-09-30): premises join with the LaTeX LAND (∧),
												    the conclusion separates by the LaTeX IMPLICATION
												    (⟹) — `A ∧ B ⟹ C`, never the misleading `A → B →
												    C` — the glyphs render through KaTeX (the app's
												    math engine), PROMINENT in the theme foreground
												    (white), not the old dim gray. A lonely chip reads
												    as a standalone proposition (no glyphs at all);
												    the row's aria-label keeps the plain-text form. */}
												<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 text-[13px] leading-tight">
													{memberIds.map((id, i) => {
														const isConclusion = i === memberIds.length - 1;
														return (
															<span key={id} className="flex items-center">
																{i > 0 && (isConclusion ? (
																	<LatexGlyph
																		cmd="\implies"
																		testid={`chain-implies-${chain.id}`}
																		className="px-1.5 text-foreground"
																	/>
																) : (
																	<LatexGlyph
																		cmd="\land"
																		testid={`chain-and-${chain.id}-${i}`}
																		className="px-1.5 text-foreground"
																	/>
																))}
																<span
																	data-testid={`prop-chip-${id}`}
																	className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5"
																>
																	{nameOf(id)}
																</span>
															</span>
														);
													})}
												</span>
												<TreeCell widthClassName="w-14" align="right" className="text-xs tabular-nums text-muted-foreground">
													{memberIds.length}
												</TreeCell>
												<TreeCell widthClassName="w-20" align="right" className="text-xs tabular-nums text-muted-foreground">
													{dateOf(chain.conclusion)}
												</TreeCell>
											</div>

											{/* The propositions — their STATEMENT text directly (owner
											    ruling: names live in the line; a singleton reveals its
											    one statement in one click). PLAIN rows: the derivation
											    is already encoded in the chain line — no conclusion
											    marker down here. Deepest indent. */}
											{chainOpen &&
												memberIds.map((id) => {
													const node = byId.get(id);
													if (!node) return null;
													return (
														<div
															key={id}
															{...chainRow(["prop", group.key, chain.id, id], depth + 2)}
															data-testid={`prop-row-${id}`}
															data-chain-statement
															{...treeRowLayout({ depth: 2, variant: "detail" })}
														>
															{selectMode ? <RowCheckbox
																checked={selection.has(id)}
																onToggle={(next) => onToggleNodes([id], next)}
																testid={`prop-checkbox-${id}`}
																label={`Select node ${node.name}`}
															/> : <TreeSelectionSpacer />}
															<ToolContentResponse
																mode="static"
																className="min-w-0 flex-1 text-muted-foreground [--font-prose:var(--font-ui)] [--lh-prose-size:var(--text-xs)] [--lh-prose-leading:1.625] [&_[data-streamdown=inline-code]]:[font-size:inherit] [&_[data-streamdown=inline-code]]:[color:inherit]"
															>
																{node.statement}
															</ToolContentResponse>
															<TreeCell widthClassName="w-14" />
															<TreeCell widthClassName="w-20" />
														</div>
													);
												})}
										</div>
									);
								})}
							<TreeSeparator data-testid={`source-separator-${group.key}`} outside inset={depth === 0 ? 0 : 1} />
						</div>
					);
				}} />
			</div>

			{/* The floating selection bar (owner ruling: never shifts layout —
			    the Google-Photos pattern). Appears only when something is
			    selected; floats over the table's bottom edge. Practice picking
			    only: outside it the checks are the tutor's source switches and
			    Delete lives in each row's "⋯" menu (fork, owner 2026-11-25). */}
			{selectMode && selection.size > 0 && (
				<div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center pb-4">
					<div
						data-testid="chain-selection-bar"
						className="pointer-events-auto flex items-center gap-3 rounded-full border bg-card py-2 pl-4 pr-2 shadow-lg"
					>
						<span data-testid="chain-selected-summary" className="text-xs font-medium">
							{selection.size} {selection.size === 1 ? "node" : "nodes"} → {derived.length} {derived.length === 1 ? "chain" : "chains"}
						</span>
						<button
							type="button"
							data-testid="chain-clear"
							onClick={onClear}
							className="rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							Clear
						</button>
						<button
							type="button"
							data-testid="chain-practice-done"
							onClick={onSelect}
							aria-label={`Done picking — ${selection.size} ${selection.size === 1 ? "proposition" : "propositions"} selected`}
							className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80"
						>
							Done
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/** The rotating chevron — collapsed points right, expanded rotates down
 *  (owner ruling: the affordance must read on every expandable row). */
function Expander({ open, onClick, testid, label }: { open: boolean; onClick: () => void; testid: string; label: string }) {
	return <TreeDisclosure open={open} onClick={onClick} data-testid={testid} aria-label={label} />;
}

/** The checkbox — checked/indeterminate (partial chains/clusters); DOM
 *  property set via ref (React does not expose `indeterminate`). */
function RowCheckbox({
	checked,
	disabled = false,
	indeterminate = false,
	onToggle,
	testid,
	label,
}: {
	checked: boolean;
	disabled?: boolean;
	indeterminate?: boolean;
	onToggle: (next: boolean) => void;
	testid: string;
	label: string;
}) {
	return (
		<TreeCheckbox disabled={disabled} checked={checked} indeterminate={indeterminate}
			data-testid={testid} aria-label={label} onChange={(e) => onToggle(e.target.checked)} />
	);
}

/** The graph view's overlay wrapper: owns query + sort + selection +
 *  expansion; mounts ABSOLUTE INSIDE the
 *  graph area, full-bleed (owner ruling: the translucent blurred surface
 *  IS the overlay — no inner card). Esc + the top-bar X dismiss (there
 *  is no backdrop margin to click anymore). Read-only toward the graph. */
export function ChainTableOverlay({
	open,
	nodes,
	chains: storedChains,
	sessions,
	fileSources,
	onClose,
	/** PRACTICE SELECT (owner vision, 2026-10-04): the selection is
	 *  PERSISTENT and caller-owned — when these props are present the
	 *  table is CONTROLLED (every check/clear/delete-prune reports up
	 *  immediately; the composer-side chip reflects it live). selectMode
	 *  only changes the floating bar: Done instead of the delete fence
	 *  (deleting while picking is a footgun). */
	selectMode,
	controlledSelection,
	onSelectionChange,
	keyboardActive = true,
	registerInteraction = true,
	pickerChrome = false,
}: {
	open: boolean;
	/** Host knowledge picker has clearance, but no sidebar-reopen action. */
	pickerChrome?: boolean;
	/** A host knowledge picker registers once through its pane or modal shell. */
	registerInteraction?: boolean;
	/** Internal host ownership; ordinary practice keeps the existing default. */
	keyboardActive?: boolean;
	nodes: GraphNode[];
	chains: GraphChain[];
	sessions: Record<string, string>;
	fileSources: Record<string, string>;
	onClose: () => void;
	selectMode?: boolean;
	controlledSelection?: ReadonlySet<string>;
	onSelectionChange?: (next: ReadonlySet<string>) => void;
}) {
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<ChainSort>({ col: "name", dir: 1 });
	const [internalSelection, setInternalSelection] = useState<ReadonlySet<string>>(() => new Set());
	const [expandedClusters, setExpandedClusters] = useState<ReadonlySet<string>>(() => new Set());
	const [expandedChains, setExpandedChains] = useState<ReadonlySet<string>>(() => new Set());
	const [deletion, setDeletion] = useState<{ sources: SourceEntry[]; folders: SourceFolder[] } | null>(null);
	const deleteOpen = deletion !== null;
	const [directory, setDirectory] = useState<SourceDirectory>();
	const [directoryPending, setDirectoryPending] = useState(true);
	const visibleDirectory = useMemo(() => directory && chainSourceDirectory(directory), [directory]);
	const [directoryFailure, setDirectoryFailure] = useState("");
	// Fork (owner, 2026-11-25): the tutor's source switches + import↔book links.
	const [inclusion, setInclusion] = useState<{ off: { sources: string[]; books: string[] }; links: Record<string, { book: string; title: string }> }>();
	const requestVersion = useRef(0);
	const directoryOpening = useRef(0);
	const directoryRequest = useRef<AbortController | null>(null);
	const mutationTail = useRef<Promise<unknown>>(Promise.resolve());
	const readDirectory = useCallback(async () => {
		const version = ++requestVersion.current;
		directoryRequest.current?.abort();
		const request = new AbortController();
		directoryRequest.current = request;
		try {
			const response = await apiFetch("/api/graph/sources", { cache: "no-store", signal: request.signal });
			if (!response.ok) throw new Error("Could not read source organization.");
			const body = await response.json() as SourceDirectory;
			if (!request.signal.aborted && version === requestVersion.current) {
				setDirectory(body); setDirectoryPending(false); setDirectoryFailure("");
				// The switches never hold up the tree, and practice picking has
				// none (fork, owner 2026-11-25).
				if (!selectMode) void apiFetch("/api/graph/source-selection", { cache: "no-store", signal: request.signal })
					.then(async (switches) => {
						const switched = switches.ok ? await switches.json() : undefined;
						if (!request.signal.aborted && version === requestVersion.current && Array.isArray(switched?.off?.sources)) setInclusion(switched);
					})
					.catch(() => {});
			}
		} catch (error) { if (!request.signal.aborted && version === requestVersion.current) setDirectoryFailure(error instanceof Error ? error.message : String(error)); }
	}, [selectMode]);
	useEffect(() => {
		if (open) void readDirectory();
		return () => {
			requestVersion.current++;
			directoryOpening.current++;
			directoryRequest.current?.abort();
			directoryRequest.current = null;
			// Keep cached organization, but require fresh source kinds on EACH opening.
			setDirectoryPending(true);
		};
	}, [open, readDirectory]);
	useServerEvent("sources-changed", () => { if (open) void readDirectory(); });
	useServerEvent("chats-changed", () => { if (open) void readDirectory(); });
	useServerResync(() => { if (open) void readDirectory(); });
	const changeOrganization: OrganizationChange = (action) => {
		const opening = directoryOpening.current;
		// Serialize this page's edits, and invalidate older notify-then-fetch reads.
		const operation = mutationTail.current.catch(() => {}).then(async () => {
			try {
				const response = await apiFetch("/api/graph/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
				const body = await response.json();
				if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not save source organization.");
				if (opening === directoryOpening.current) {
					requestVersion.current++;
					setDirectory(body as SourceDirectory); setDirectoryPending(false); setDirectoryFailure("");
				}
				if (action.action === "rename-source") {
					const entry = (body as SourceDirectory).sources.find((s) => s.id === action.id);
					window.dispatchEvent(new CustomEvent(entry?.kind === "chat" ? "lh:chat-renamed" : "lh:source-renamed", { detail: { id: action.id, title: action.name } }));
				}
				return typeof body.createdFolderId === "string" ? body.createdFolderId : undefined;
			} catch (error) { setDirectoryFailure(error instanceof Error ? error.message : String(error)); throw error; }
		});
		mutationTail.current = operation;
		return operation;
	};
	const offSources = new Set(inclusion?.off.sources ?? []);
	const sourceOn = (id: string) => !offSources.has(id);
	// One write per click; the optimistic state shows at once, the reply
	// (and sources-changed) confirms it.
	const switchSources = (ids: string[], on: boolean) => {
		if (!ids.length) return;
		setInclusion((previous) => previous && {
			...previous,
			off: { ...previous.off, sources: on ? previous.off.sources.filter((id) => !ids.includes(id)) : [...new Set([...previous.off.sources, ...ids])] },
		});
		const operation = mutationTail.current.catch(() => {}).then(async () => {
			try {
				const response = await apiFetch("/api/graph/source-selection", { method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ changes: ids.map((id) => ({ kind: "source", id, on })) }) });
				const body = await response.json();
				if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not save the source switches.");
				setInclusion(body); setDirectoryFailure("");
			} catch (error) { setDirectoryFailure(error instanceof Error ? error.message : String(error)); void readDirectory(); }
		});
		mutationTail.current = operation;
	};

	// Controlled when the caller lifts the selection (the practice pick
	// set); internal (uncontrolled) otherwise.
	const selection = controlledSelection ?? internalSelection;
	const applySelection = (next: ReadonlySet<string>) => {
		if (onSelectionChange) onSelectionChange(next);
		else setInternalSelection(next);
	};

	const rootRef = useRef<HTMLDivElement>(null);
	const inheritedOwner = useContext(InteractionLayerOwner);
	const layer = useInteractionLayer({
		kind: "view", enabled: open && keyboardActive && registerInteraction, rootRef,
		onClose: () => { onClose(); return "closed"; },
	});

	if (!open) return null;

	const toggleNodes = (ids: string[], next: boolean) => {
		const s = new Set(selection);
		for (const id of ids) {
			if (next) s.add(id);
			else s.delete(id);
		}
		applySelection(s);
	};
	const toggleIn = (set: ReadonlySet<string>, id: string) => {
		const s = new Set(set);
		if (s.has(id)) s.delete(id);
		else s.add(id);
		return s;
	};

	return (
		<InteractionLayerOwner.Provider value={registerInteraction && keyboardActive ? layer.id : inheritedOwner}>
			<div
				ref={rootRef}
				data-testid="chain-table-overlay"
				className="absolute inset-0 z-40 flex flex-col bg-background/80 backdrop-blur-sm"
				style={registerInteraction ? { zIndex: 100 + layer.order } : undefined}
			>
				{directoryFailure && <p role="alert" className="px-3 py-1 text-xs text-error">{directoryFailure}</p>}
				<ChainTableBody
					pickerChrome={pickerChrome}
					keyboardActive={keyboardActive && !deleteOpen}
					directory={directory}
					onOrganizationChange={directory ? changeOrganization : undefined}
					sourceOn={sourceOn}
					linkedBooks={inclusion?.links ?? {}}
					onDeleteEntry={selectMode ? undefined : (kind, id) => {
						if (!visibleDirectory) return;
						if (kind === "source") {
							const entry = visibleDirectory.sources.find((s) => s.id === id);
							if (entry) setDeletion({ sources: [entry], folders: [] });
							return;
						}
						const entries = folderEntries(visibleDirectory, id);
						setDeletion({
							sources: visibleDirectory.sources.filter((s) => entries.sources.includes(s.id)),
							folders: visibleDirectory.organization.folders.filter((f) => entries.folders.includes(f.id)),
						});
					}}
					onToggleSource={(id, next) => switchSources([id], next)}
					onToggleFolder={(id, next) => { if (visibleDirectory) switchSources(folderEntries(visibleDirectory, id).sources, next); }}
					sourceInventoryPending={directoryPending}
					nodes={nodes}
					chains={storedChains}
					sessions={sessions}
					fileSources={fileSources}
					query={query}
					onQuery={setQuery}
					sort={sort}
					onSort={(col) =>
						setSort((prev) =>
							prev.col === col
								? { col, dir: prev.dir === 1 ? -1 : 1 }
								: { col, dir: col === "name" ? 1 : -1 },
						)
					}
					selection={selection}
					expandedClusters={expandedClusters}
					expandedChains={expandedChains}
					onToggleCluster={(key) => setExpandedClusters((prev) => toggleIn(prev, key))}
					onToggleChain={(id) => setExpandedChains((prev) => toggleIn(prev, id))}
					onToggleNodes={toggleNodes}
					onClear={() => applySelection(new Set())}
					onClose={onClose}
					selectMode={selectMode}
					onSelect={onClose}
				/>
			</div>
			{!selectMode && <DeleteSourceDialog open={deleteOpen}
				sources={deletion?.sources ?? []}
				folders={deletion?.folders ?? []}
				linkedBooks={(deletion?.sources ?? []).filter((s) => s.kind === "notes" && inclusion?.links[s.id]).length}
				onClose={() => setDeletion(null)}
				onDelete={(deleteSessions, deleteBooks) => {
					const opening = directoryOpening.current;
					const operation = mutationTail.current.catch(() => {}).then(async () => {
						let graphRevision: number | undefined;
						try {
							const response = await apiFetch("/api/graph/sources", { method: "DELETE", headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ sourceIds: deletion?.sources.map((s) => s.id) ?? [], folderIds: deletion?.folders.map((f) => f.id) ?? [], deleteSessions, deleteBooks }) });
							const body = await response.json();
							if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not delete sources.");
							graphRevision = body.graphRevision;
							if (opening === directoryOpening.current) {
								requestVersion.current++; setDirectory(body as SourceDirectory); setDirectoryPending(false); setDirectoryFailure("");
							}
						} finally {
							// A failed response can still follow partial disk writes.
							// Refresh graph content as well as the directory, in both home modes.
							void readDirectory();
							window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { graphRevision } }));
						}
					});
					mutationTail.current = operation; return operation;
				}}
			/>}
		</InteractionLayerOwner.Provider>
	);
}
