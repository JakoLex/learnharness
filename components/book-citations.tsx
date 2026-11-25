"use client";

/**
 * BOOK CITATIONS IN THE CHAT (fork, owner 2026-11-24). An agent cites a
 * book page with a markdown link to the shelf page
 * (`/p/<project>/books?book=bk_…&page=N`). The rehype step below renames
 * exactly those links to <book-citation>, so every other link keeps
 * Streamdown's own link handling; the component opens the page viewer in
 * place and marks a citation whose page no search_books / read_book_page
 * result in this chat showed the agent.
 */
import { createContext, useContext, useState, type ComponentProps, type ReactNode } from "react";
import type { Element, Root } from "hast";
import { BookOpenIcon } from "lucide-react";
import { parseBookCitationHref } from "@/src/core";
import { BookPageViewer } from "./book-page-viewer";

/** The chat's looked-up pages ("bk_…:page"); null outside a chat (no marks). */
export const BookCitationContext = createContext<ReadonlySet<string> | null>(null);

export const BOOK_CITATION_TAG = "book-citation";

function visit(node: Root | Element): void {
	for (const child of node.children) {
		if (child.type !== "element") continue;
		if (child.tagName === "a" && parseBookCitationHref(typeof child.properties?.href === "string" ? child.properties.href : null)) {
			child.tagName = BOOK_CITATION_TAG;
		}
		visit(child);
	}
}

/** Rehype: book citation links → <book-citation href=…>. */
export function rehypeBookCitations() {
	return (tree: Root) => visit(tree);
}

export function BookCitationLink(props: ComponentProps<"a"> & { node?: unknown; children?: ReactNode }) {
	const { href, children } = props;
	const consulted = useContext(BookCitationContext);
	const [open, setOpen] = useState(false);
	const citation = parseBookCitationHref(href);
	if (!citation) return <>{children}</>;
	const unverified = consulted !== null && !consulted.has(`${citation.book}:${citation.page}`);
	return (
		<>
			<a
				href={href}
				data-testid="book-citation"
				data-verified={unverified ? "false" : "true"}
				title={unverified ? "Not looked up: the tutor did not read or find this page in this chat" : "Open the page"}
				onClick={(e) => {
					if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
					e.preventDefault();
					setOpen(true);
				}}
				className="inline-flex items-baseline gap-1 underline decoration-dotted underline-offset-2 hover:decoration-solid"
			>
				<BookOpenIcon aria-hidden="true" className="size-3 shrink-0 self-center opacity-70" />
				{children}
				{unverified && <span className="text-[0.75em] text-warning no-underline" aria-label="not looked up">(not looked up)</span>}
			</a>
			{open && <BookPageViewer projectId={citation.projectId} bookId={citation.book} page={citation.page} onClose={() => setOpen(false)} />}
		</>
	);
}
