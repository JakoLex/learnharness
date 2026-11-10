"use client";

/**
 * The graph review control (fork, owner 2026-11-10): a "Review" button in
 * the graph bar whose panel starts a review (the confirmation step), shows
 * its protocol — every merge, correction, chain repair/deletion and new
 * connection with the model's reason — and undoes it. A click on an entry
 * focuses its node on the canvas. Server side: /api/graph/review.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import type { ReviewEntry, ReviewProtocol } from "@/src/core";
import { apiFetch } from "@/components/api-fetch";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { Hint } from "@/components/ui/hint";

const PHASE_LABEL: Record<NonNullable<ReviewProtocol["phase"]>, string> = {
	duplicates: "looking for duplicates",
	errors: "checking propositions",
	chains: "checking chains",
	bridges: "looking for missing connections",
	layout: "settling the layout",
};

const POLL_MS = 4000;
/** Least distance between the panel and the screen edge (px). */
const EDGE_GAP = 12;

export function GraphReviewControl({
	names,
	onFocusNode,
	onGraphChanged,
}: {
	/** Current node names by id (the snapshot's propositions). */
	names: ReadonlyMap<string, string>;
	onFocusNode: (id: string) => void;
	/** The graph changed under the canvas (undo) — refetch it. */
	onGraphChanged: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [protocol, setProtocol] = useState<ReviewProtocol | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	// Keep the panel on screen: it hangs under the button, which sits at a
	// different place on a phone than on a tablet. (A fixed panel would not
	// help — the backdrop-blurred bar is its containing block.)
	const panelRef = useRef<HTMLDivElement>(null);
	const [shift, setShift] = useState(0);
	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (!open || !panel) return;
		const r = panel.getBoundingClientRect();
		let fix = 0;
		if (r.left < EDGE_GAP) fix = EDGE_GAP - r.left;
		else if (r.right > window.innerWidth - EDGE_GAP) fix = window.innerWidth - EDGE_GAP - r.right;
		if (Math.abs(fix) > 0.5) setShift((s) => s + fix);
	});
	useEffect(() => {
		if (!open) setShift(0);
	}, [open]);

	const load = useCallback(() => {
		apiFetch("/api/graph/review")
			.then((res) => res.json() as Promise<{ protocol: ReviewProtocol | null }>)
			.then((data) => setProtocol(data.protocol))
			.catch((err) => console.error("[review] fetch failed", err));
	}, []);

	useEffect(() => {
		if (open) load();
	}, [open, load]);
	const running = protocol?.status === "running";
	useEffect(() => {
		if (!open || !running) return;
		const id = setInterval(load, POLL_MS);
		return () => clearInterval(id);
	}, [open, running, load]);

	const post = async (url: string) => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch(url, { method: "POST" });
			const data = (await res.json()) as { protocol?: ReviewProtocol; error?: string };
			if (!res.ok || !data.protocol) setError(data.error ?? `Request failed (${res.status}).`);
			else {
				setProtocol(data.protocol);
				if (data.protocol.status === "undone") onGraphChanged();
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const counts = protocol ? countEntries(protocol.entries) : null;
	const canUndo = protocol?.status === "done" || protocol?.status === "failed";

	return (
		<div ref={rootRef} className="relative">
			<Hint label="Review the graph: duplicates, errors, missing connections" side="bottom">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
					data-testid="open-graph-review"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
				>
					{running ? <Loader2Icon className="size-3 animate-spin" /> : <SparklesIcon className="size-3" />}
					<span className="max-md:sr-only">Review</span>
				</button>
			</Hint>
			{open && (
				<div
					ref={panelRef}
					style={{ transform: `translateX(${shift}px)` }}
					className="absolute right-0 top-full z-20 mt-2 flex max-h-[70vh] w-96 max-w-[calc(100vw-1.5rem)] flex-col rounded-xl border bg-card/95 text-xs shadow-lg backdrop-blur"
				>
					<div className={`flex flex-col gap-2 p-3 ${protocol && protocol.entries.length > 0 ? "border-b" : ""}`}>
						<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Graph review</span>
						{running ? (
							<p className="text-muted-foreground">
								Running — {protocol?.phase ? PHASE_LABEL[protocol.phase] : "starting"}… Changes appear below as they are made.
							</p>
						) : (
							<>
								<p className="text-muted-foreground">
									Merges duplicates, corrects wrong propositions, repairs or removes broken chains and adds missing
									connections — automatically. Takes a while; you can undo it afterwards.
								</p>
								<div className="flex gap-2">
									<button
										type="button"
										disabled={busy}
										onClick={() => void post("/api/graph/review")}
										className="rounded-lg bg-primary px-2.5 py-1 text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
									>
										Start review
									</button>
									{canUndo && (
										<button
											type="button"
											disabled={busy}
											onClick={() => void post("/api/graph/review/undo")}
											className="rounded-lg border px-2.5 py-1 transition-colors hover:bg-accent disabled:opacity-50"
										>
											Undo last review
										</button>
									)}
								</div>
							</>
						)}
						{error && <p className="text-destructive">{error}</p>}
						{protocol && !running && (
							<p className="text-muted-foreground">
								Last review {statusText(protocol)}
								{counts && ` — ${summary(counts)}`}
							</p>
						)}
					</div>
					{protocol && protocol.entries.length > 0 && (
						<ul className="flex flex-col divide-y overflow-y-auto">
							{protocol.entries.map((entry, i) => (
								<ReviewEntryRow key={i} entry={entry} names={names} onFocusNode={onFocusNode} undone={protocol.status === "undone"} />
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}

function statusText(p: ReviewProtocol): string {
	const when = p.finishedAt ? new Date(p.finishedAt).toLocaleString() : new Date(p.startedAt).toLocaleString();
	if (p.status === "undone") return `(${when}) was undone`;
	if (p.status === "failed") return `(${when}) stopped early${p.error ? `: ${p.error}` : ""}`;
	return `(${when})`;
}

function countEntries(entries: readonly ReviewEntry[]) {
	const c = { merge: 0, correct: 0, "chain-repair": 0, "chain-delete": 0, bridge: 0 };
	for (const e of entries) c[e.kind]++;
	return c;
}

function summary(c: ReturnType<typeof countEntries>): string {
	const parts = [
		c.merge && `${c.merge} merged`,
		c.correct && `${c.correct} corrected`,
		c["chain-repair"] && `${c["chain-repair"]} chains repaired`,
		c["chain-delete"] && `${c["chain-delete"]} chains removed`,
		c.bridge && `${c.bridge} new connections`,
	].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : "no changes";
}

function ReviewEntryRow({
	entry,
	names,
	onFocusNode,
	undone,
}: {
	entry: ReviewEntry;
	names: ReadonlyMap<string, string>;
	onFocusNode: (id: string) => void;
	undone: boolean;
}) {
	const name = (id: string) => names.get(id) ?? id;
	const premises = (ids: readonly string[]) => ids.map(name).join(" + ");
	let title: string;
	let focus: string;
	let body: ReactNode;
	switch (entry.kind) {
		case "merge":
			title = "Merged";
			focus = entry.survivor;
			body = (
				<>
					<Change before={`${entry.removed.name}: ${entry.removed.statement}`} after={`${entry.after.name}: ${entry.after.statement}`} />
				</>
			);
			break;
		case "correct":
			title = "Corrected";
			focus = entry.id;
			body = <Change before={`${entry.before.name}: ${entry.before.statement}`} after={`${entry.after.name}: ${entry.after.statement}`} />;
			break;
		case "chain-repair":
			title = "Chain repaired";
			focus = entry.conclusion;
			body = <Change before={`${premises(entry.before)} ⇒ ${name(entry.conclusion)}`} after={`${premises(entry.after)} ⇒ ${name(entry.conclusion)}`} />;
			break;
		case "chain-delete":
			title = "Chain removed";
			focus = entry.conclusion;
			body = <p className="text-muted-foreground line-through">{`${premises(entry.premises)} ⇒ ${name(entry.conclusion)}`}</p>;
			break;
		case "bridge":
			title = "New connection";
			focus = entry.conclusion;
			body = <p>{`${premises(entry.premises)} ⇒ ${name(entry.conclusion)}`}</p>;
			break;
	}
	return (
		<li>
			<button
				type="button"
				disabled={undone || !names.has(focus)}
				onClick={() => onFocusNode(focus)}
				className="flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
			>
				<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
				{body}
				{entry.reason && <span className="text-[11px] italic text-muted-foreground">{entry.reason}</span>}
			</button>
		</li>
	);
}

function Change({ before, after }: { before: string; after: string }) {
	return (
		<span className="flex flex-col gap-0.5">
			<span className="text-muted-foreground line-through">{before}</span>
			<span>{after}</span>
		</span>
	);
}
