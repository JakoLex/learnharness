"use client";

/**
 * THE BOOK PAGE VIEWER (fork, owner 2026-11-24): one page of a book on the
 * project's shelf, rendered on the server (pdf.js), with paging. Opened
 * from the shelf page and from a citation link in the chat.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { HostDialog } from "./host-dialog";
import { apiUrlWithProject } from "./api-fetch";
import { pageCaption, type BookRecord } from "@/src/core";

export function BookPageViewer({ projectId, bookId, page, book: known, onClose }: {
	projectId: string;
	bookId: string;
	page: number;
	/** The record when the opener has it; fetched otherwise. */
	book?: BookRecord;
	onClose: () => void;
}) {
	const [book, setBook] = useState<BookRecord | null>(known ?? null);
	const [failure, setFailure] = useState("");
	const [current, setCurrent] = useState(page);
	const [loaded, setLoaded] = useState(false);
	const [imageError, setImageError] = useState(false);

	useEffect(() => {
		if (known) return;
		let live = true;
		fetch(apiUrlWithProject("/api/books", projectId))
			.then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
			.then((body: { books?: BookRecord[] }) => {
				if (!live) return;
				const found = body.books?.find((b) => b.id === bookId);
				if (found) setBook(found);
				else setFailure("This book is no longer on the shelf.");
			})
			.catch(() => { if (live) setFailure("Could not load the book."); });
		return () => { live = false; };
	}, [known, projectId, bookId]);

	useEffect(() => { setLoaded(false); setImageError(false); }, [current]);

	const pages = book?.pageCount ?? 0;
	const go = useCallback((delta: number) => {
		setCurrent((p) => Math.min(Math.max(1, p + delta), pages || p));
	}, [pages]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
			else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [go]);

	const title = book?.title ?? "Book";
	const frame = (
		<div role="dialog" aria-modal="true" aria-label={`${title}, page`} data-testid="book-page-viewer"
			onClick={(e) => e.stopPropagation()}
			className="flex max-h-[calc(100dvh-2rem)] w-[56rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card shadow-xl">
			<div className="flex items-center gap-3 border-b px-4 py-2.5">
				<div className="min-w-0 flex-1">
					<h2 className="truncate text-sm font-semibold">{title}</h2>
					<p className="text-xs text-muted-foreground" data-testid="book-page-caption">
						{book ? `${pageCaption(book, current)} · PDF page ${current} of ${pages}` : `PDF page ${current}`}
					</p>
				</div>
				<button type="button" aria-label="Previous page" disabled={current <= 1} onClick={() => go(-1)}
					className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30">
					<ChevronLeftIcon className="size-4" />
				</button>
				<button type="button" aria-label="Next page" disabled={!pages || current >= pages} onClick={() => go(1)}
					className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30">
					<ChevronRightIcon className="size-4" />
				</button>
				<button type="button" aria-label="Close" onClick={onClose}
					className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					<XIcon className="size-4" />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-3">
				{failure ? (
					<p role="alert" className="p-6 text-center text-sm text-muted-foreground">{failure}</p>
				) : (
					<>
						{!loaded && !imageError && <p className="p-6 text-center text-xs text-muted-foreground">Rendering the page…</p>}
						{imageError && <p role="alert" className="p-6 text-center text-sm text-muted-foreground">This page could not be rendered.</p>}
						{/* eslint-disable-next-line @next/next/no-img-element -- a server-rendered page image, not a static asset */}
						<img
							key={current}
							src={apiUrlWithProject(`/api/books/${bookId}/page/${current}`, projectId)}
							alt={`${title}, PDF page ${current}`}
							onLoad={() => setLoaded(true)}
							onError={() => setImageError(true)}
							className={loaded ? "mx-auto h-auto max-w-full rounded bg-white shadow-sm" : "hidden"}
						/>
					</>
				)}
			</div>
		</div>
	);
	return (
		<HostDialog open frame={frame} onClose={() => { onClose(); return "closed"; }}
			backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}>
			{frame.props.children}
		</HostDialog>
	);
}
