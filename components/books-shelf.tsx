"use client";

/**
 * THE BOOKSHELF PAGE (fork, owner 2026-11-24): /p/<project>/books — the
 * project's reference books. Upload (button or drop), indexing progress,
 * rename, the printed-page offset for PDFs without page labels, retry,
 * delete, and the page viewer. `?book=&page=` (a citation link opened on
 * its own) opens the viewer right away.
 *
 * Fork (owner, 2026-11-25): each book has the tutor's on/off switch
 * (core/source-inclusion.ts). A PDF imported into the map lands here too,
 * linked to its import: one switch for both, and Delete offers to take
 * the import along.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { BookOpenIcon, RotateCcwIcon, Trash2Icon, UploadIcon, WaypointsIcon } from "lucide-react";
import { SidebarToggle } from "@/components/sidebar";
import { apiFetch, currentProjectId } from "./api-fetch";
import { BookPageViewer } from "./book-page-viewer";
import { useServerEvent } from "./server-events";
import type { BookRecord } from "@/src/core";
import { loaderProgress, type Progress } from "@/lib/run-progress";
import { ProgressBar } from "./progress-bar";

async function failureText(res: Response): Promise<string> {
	const body = (await res.json().catch(() => null)) as { error?: string } | null;
	return body?.error ?? `Request failed (HTTP ${res.status}).`;
}

function statusLine(book: BookRecord): { text: string; tone: "busy" | "ok" | "warn" | "error" } {
	if (book.status === "failed") return { text: `Failed: ${book.error ?? "unknown error"}`, tone: "error" };
	if (book.status === "indexing") return { text: `Indexing — ${book.activity ?? "working"}…`, tone: "busy" };
	if (book.vectors === "running") {
		return { text: `Searchable · meaning index ${book.embedded ?? 0}/${book.chunks ?? "?"}`, tone: "busy" };
	}
	if (book.vectors === "pending") {
		return { text: `Keyword search only${book.vectorNote ? ` — meaning index waits (${book.vectorNote})` : " — meaning index waits"}`, tone: "warn" };
	}
	return { text: "Ready", tone: "ok" };
}

/** Fork (owner, 2026-11-25): the shelf's progress bar — the doc loader's
 *  pages while it reads the book, then the meaning index's chunks. */
export function bookProgress(book: BookRecord): Progress | null {
	if (book.status === "indexing" && book.reading) return loaderProgress(book.reading);
	if (book.status === "indexing") return { fraction: null, text: "" };
	if (book.vectors === "running") {
		const chunks = book.chunks ?? 0;
		return { fraction: chunks > 0 ? Math.min(1, (book.embedded ?? 0) / chunks) : null, text: "" };
	}
	return null;
}

const TONE: Record<ReturnType<typeof statusLine>["tone"], string> = {
	busy: "text-muted-foreground",
	ok: "text-muted-foreground",
	warn: "text-warning",
	error: "text-error",
};

export function BookRow({ book, on, onSwitch, onChanged, onOpen }: {
	book: BookRecord; on: boolean; onSwitch: (on: boolean) => void; onChanged: () => void; onOpen: (page: number) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [withImport, setWithImport] = useState(false);
	const [title, setTitle] = useState(book.title);
	const [firstPage, setFirstPage] = useState(book.firstPage ? String(book.firstPage) : "");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [failure, setFailure] = useState("");
	useEffect(() => { if (!editing) setTitle(book.title); }, [book.title, editing]);
	useEffect(() => { setFirstPage(book.firstPage ? String(book.firstPage) : ""); }, [book.firstPage]);

	const send = async (init: RequestInit, query = "") => {
		setFailure("");
		const res = await apiFetch(`/api/books/${book.id}${query}`, init);
		if (!res.ok) setFailure(await failureText(res));
		onChanged();
		return res.ok;
	};
	const patch = (body: object) => send({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const saveTitle = async () => {
		setEditing(false);
		if (title.trim() && title.trim() !== book.title) await patch({ title: title.trim() });
		else setTitle(book.title);
	};
	const saveFirstPage = async () => {
		const value = firstPage.trim();
		const next = value === "" ? null : Number(value);
		if ((next ?? undefined) === book.firstPage) return;
		await patch({ firstPage: next });
	};
	const status = statusLine(book);
	const progress = bookProgress(book);

	return (
		<li data-testid="book-row" className={`rounded-xl border bg-card px-4 py-3${on ? "" : " opacity-60"}`}>
			<div className="flex items-start gap-3">
				<input type="checkbox" checked={on} data-testid="book-switch" onChange={(e) => onSwitch(e.target.checked)}
					aria-label={`Include ${book.title} for the tutor`} title="Checked: the tutor searches and reads this book"
					className="mt-1 size-3.5 shrink-0 accent-primary" />
				<BookOpenIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<div className="min-w-0 flex-1">
					{editing ? (
						<input autoFocus value={title} aria-label="Book title" onChange={(e) => setTitle(e.target.value)}
							onBlur={() => void saveTitle()}
							onKeyDown={(e) => {
								if (e.key === "Enter") void saveTitle();
								if (e.key === "Escape") { setTitle(book.title); setEditing(false); }
							}}
							className="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none focus:border-ring" />
					) : (
						<button type="button" title="Rename" onClick={() => setEditing(true)} className="max-w-full truncate text-left text-sm font-medium hover:underline">
							{book.title}
						</button>
					)}
					<p className="mt-0.5 text-xs text-muted-foreground">
						{book.pageCount ? `${book.pageCount} pages · ` : ""}{(book.bytes / (1024 * 1024)).toFixed(1)} MB · {book.fileName}
					</p>
					{book.sourceId && (
						<p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground" data-testid="book-linked">
							<WaypointsIcon className="size-3 shrink-0" /> Also imported into the map — one switch for both (Chains shows it too).
						</p>
					)}
					<p className={`mt-1 text-xs ${TONE[status.tone]}`} data-testid="book-status">{status.text}</p>
					{progress && (
						<div className="mt-1.5 flex max-w-md items-center gap-2 text-xs text-muted-foreground" data-testid="book-progress">
							<ProgressBar fraction={progress.fraction} className="flex-1" />
							{progress.text && <span className="truncate tabular-nums">{progress.text}</span>}
						</div>
					)}
					{book.notice && <p className="mt-1 text-xs text-muted-foreground">{book.notice}</p>}
					{book.pageCount > 0 && (book.pageLabels ? (
						<p className="mt-1 text-xs text-muted-foreground">Printed page numbers come from the PDF.</p>
					) : (
						<label className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							<span>Printed page 1 is PDF page</span>
							<input type="number" min={1} max={book.pageCount} inputMode="numeric" value={firstPage} placeholder="–"
								aria-label="PDF page of printed page 1"
								onChange={(e) => setFirstPage(e.target.value)}
								onBlur={() => void saveFirstPage()}
								onKeyDown={(e) => { if (e.key === "Enter") void saveFirstPage(); }}
								className="w-20 rounded-md border bg-background px-2 py-0.5 text-xs outline-none focus:border-ring" />
							<span className="text-muted-foreground/70">(empty: page numbers are PDF pages)</span>
						</label>
					))}
					{failure && <p role="alert" className="mt-1 text-xs text-destructive">{failure}</p>}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{book.status === "failed" && (
						<button type="button" title="Index again" aria-label="Index again" onClick={() => void send({ method: "POST" })}
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
							<RotateCcwIcon className="size-4" />
						</button>
					)}
					{book.pageCount > 0 && (
						<button type="button" onClick={() => onOpen(book.firstPage ?? 1)}
							className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
							Open
						</button>
					)}
					{confirmDelete ? (
						<span className="flex flex-col items-end gap-1">
							<span className="flex items-center gap-1">
								<button type="button" onClick={() => { setConfirmDelete(false); setWithImport(false); }} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
								<button type="button" data-testid="book-delete-confirm" onClick={() => void send({ method: "DELETE" }, withImport && book.sourceId ? "?with=import" : "")}
									className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-xs text-destructive hover:bg-destructive/20">Delete</button>
							</span>
							{book.sourceId && (
								<label className="flex max-w-56 cursor-pointer items-start gap-1.5 text-right text-xs text-muted-foreground">
									<input type="checkbox" data-testid="book-delete-import" checked={withImport} onChange={(e) => setWithImport(e.target.checked)}
										className="mt-0.5 size-3 shrink-0 accent-primary" />
									<span>Also delete the import and its propositions in the map</span>
								</label>
							)}
						</span>
					) : (
						<button type="button" title="Delete" aria-label="Delete" onClick={() => setConfirmDelete(true)}
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive">
							<Trash2Icon className="size-4" />
						</button>
					)}
				</div>
			</div>
		</li>
	);
}

export function BooksShelf() {
	const [books, setBooks] = useState<BookRecord[] | null>(null);
	const [off, setOff] = useState<{ sources: string[]; books: string[] }>({ sources: [], books: [] });
	const [failure, setFailure] = useState("");
	const [messages, setMessages] = useState<string[]>([]);
	const [uploading, setUploading] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);
	const [viewer, setViewer] = useState<{ book: string; page: number } | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const projectId = currentProjectId();

	const refresh = useCallback(async () => {
		const res = await apiFetch("/api/books").catch(() => null);
		if (!res?.ok) { setFailure(res ? await failureText(res) : "Could not load the shelf."); return; }
		setFailure("");
		setBooks(((await res.json()) as { books: BookRecord[] }).books);
		const switches = await apiFetch("/api/graph/source-selection").catch(() => null);
		if (switches?.ok) {
			const body = (await switches.json().catch(() => null)) as { off?: { sources: string[]; books: string[] } } | null;
			if (body?.off) setOff(body.off);
		}
	}, []);

	useEffect(() => { void refresh(); }, [refresh]);
	// Chains switches and deletions land here too.
	useServerEvent("sources-changed", () => { void refresh(); });

	const bookOn = (book: BookRecord) => (book.sourceId ? !off.sources.includes(book.sourceId) : !off.books.includes(book.id));
	const switchBook = async (book: BookRecord, on: boolean) => {
		setOff((previous) => book.sourceId
			? { ...previous, sources: on ? previous.sources.filter((id) => id !== book.sourceId) : [...previous.sources, book.sourceId] }
			: { ...previous, books: on ? previous.books.filter((id) => id !== book.id) : [...previous.books, book.id] });
		const res = await apiFetch("/api/graph/source-selection", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ changes: [{ kind: "book", id: book.id, on }] }),
		}).catch(() => null);
		if (!res?.ok) setFailure(res ? await failureText(res) : "Could not save the switch.");
		void refresh();
	};

	// A citation link opened on its own: ?book=…&page=… opens the viewer.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const book = params.get("book");
		const page = Number(params.get("page"));
		if (book) setViewer({ book, page: Number.isInteger(page) && page > 0 ? page : 1 });
	}, []);

	// Poll while something is being indexed.
	const busy = books?.some((b) => b.status === "indexing" || b.vectors === "running") ?? false;
	useEffect(() => {
		if (!busy) return;
		const timer = setInterval(() => void refresh(), 3000);
		return () => clearInterval(timer);
	}, [busy, refresh]);

	const upload = async (files: File[]) => {
		const notes: string[] = [];
		for (const file of files) {
			setUploading(file.name);
			const form = new FormData();
			form.append("file", file);
			const res = await apiFetch("/api/books", { method: "POST", body: form }).catch(() => null);
			if (!res) notes.push(`${file.name}: the upload did not reach LH.`);
			else if (!res.ok) notes.push(`${file.name}: ${await failureText(res)}`);
			else {
				const body = (await res.json()) as { book: BookRecord; duplicate: boolean };
				if (body.duplicate) notes.push(`${file.name} is already on the shelf as “${body.book.title}”.`);
			}
			await refresh();
		}
		setUploading(null);
		setMessages(notes);
	};

	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setDragging(false);
		const files = [...e.dataTransfer.files];
		if (files.length) void upload(files);
	};

	const viewed = viewer ? books?.find((b) => b.id === viewer.book) : undefined;

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<header className="flex items-center gap-2 px-3 py-2">
				<SidebarToggle />
			</header>
			<div
				className={`min-h-0 flex-1 overflow-y-auto ${dragging ? "bg-accent/40" : ""}`}
				onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.stopPropagation(); setDragging(true); } }}
				onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
				onDrop={onDrop}
				data-testid="books-shelf"
			>
				<div className="mx-auto max-w-3xl px-4 pb-10 pt-2">
					<div className="flex items-start gap-3">
						<div className="min-w-0 flex-1">
							<h1 className="text-lg font-semibold">Books</h1>
							<p className="mt-1 text-sm text-muted-foreground">
								Reference books for this project. The tutor searches them and cites pages; a book uploaded here does not go into the map.
								A PDF imported into the map lands here too, linked to its import. Uncheck a book to keep the tutor out of it.
								Drop PDFs here or upload them (up to 100 MB each).
							</p>
						</div>
						<button type="button" disabled={uploading !== null} onClick={() => input.current?.click()}
							className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50">
							<UploadIcon className="size-3.5" /> {uploading ? "Uploading…" : "Upload PDF"}
						</button>
						<input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden
							onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) void upload(files); }} />
					</div>
					{uploading && <p className="mt-3 text-xs text-muted-foreground">Uploading {uploading}…</p>}
					{messages.map((m) => <p key={m} role="status" className="mt-2 text-xs text-muted-foreground">{m}</p>)}
					{failure && <p role="alert" className="mt-3 text-sm text-destructive">{failure}</p>}
					{books && books.length === 0 && (
						<p className="mt-8 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No books yet.</p>
					)}
					{books && books.length > 0 && (
						<ul className="mt-5 flex flex-col gap-2">
							{books.map((book) => (
								<BookRow key={book.id} book={book} on={bookOn(book)} onSwitch={(on) => void switchBook(book, on)}
									onChanged={() => void refresh()} onOpen={(page) => setViewer({ book: book.id, page })} />
							))}
						</ul>
					)}
				</div>
			</div>
			{viewer && projectId && (
				<BookPageViewer key={`${viewer.book}:${viewer.page}`} projectId={projectId} bookId={viewer.book} page={viewer.page} book={viewed}
					onClose={() => {
						setViewer(null);
						if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
					}} />
			)}
		</div>
	);
}
