/**
 * THE SOURCE SWITCHES (fork, owner 2026-11-25) — what the chat agents take
 * into account, per project (core/source-inclusion.ts). Chains and the
 * bookshelf both switch through here; a book linked to an import shares
 * the import's switch.
 */
import { stores } from "./stores.ts";
import { bookLinks } from "./books.ts";
import {
	applySourceInclusionChanges, parseSourceInclusionChanges, sourceSwitches,
	type SourceInclusion, type SourceSwitches,
} from "../core/source-inclusion.ts";

export class SourceSelectionInputError extends Error {}

export interface SourceSelectionView {
	off: SourceInclusion["off"];
	/** import id → its linked book */
	links: Record<string, { book: string; title: string }>;
}

export function readSourceSelection(): SourceSelectionView {
	return { off: stores.sourceSelectionStore.read().off, links: bookLinks() };
}

export function changeSourceSelection(raw: unknown): SourceSelectionView {
	let changes;
	try { changes = parseSourceInclusionChanges(raw); }
	catch (error) { throw new SourceSelectionInputError((error as Error).message); }
	const links = bookLinks();
	const books = Object.entries(links).map(([sourceId, link]) => ({ id: link.book, sourceId }));
	stores.sourceSelectionStore.write(applySourceInclusionChanges(stores.sourceSelectionStore.read(), changes, books));
	return readSourceSelection();
}

/** The current switches, read fresh on every call (agent tools). */
export function currentSourceSwitches(): SourceSwitches {
	return sourceSwitches(stores.sourceSelectionStore.read());
}
