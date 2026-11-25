"use client";

/**
 * A row's "⋯" menu (fork, owner 2026-11-25): Chains moved Delete out of
 * the checkbox selection — the checkboxes are the chat agents' source
 * switches now — into one menu per source and folder row. A plain button
 * plus a small popover; it closes on a pick, an outside click, Escape or
 * when focus leaves it.
 */
import { useEffect, useRef, useState } from "react";
import { EllipsisIcon } from "lucide-react";

export interface RowMenuItem {
	label: string;
	testid: string;
	destructive?: boolean;
	onSelect: () => void;
}

export function RowMenu({ label, items, testid }: { label: string; items: RowMenuItem[]; testid: string }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (!open) return;
		const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
		document.addEventListener("pointerdown", away, true);
		return () => document.removeEventListener("pointerdown", away, true);
	}, [open]);
	return (
		<span ref={root} className="lh-no-drag relative flex shrink-0"
			onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}
			onKeyDown={(e) => { if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); } }}>
			<button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} data-testid={testid}
				onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
				className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
				<EllipsisIcon className="size-3.5" />
			</button>
			{open && (
				<span role="menu" className="absolute right-0 top-6 z-20 flex min-w-32 flex-col rounded-md border bg-card py-1 shadow-lg">
					{items.map((item) => (
						<button key={item.testid} type="button" role="menuitem" data-testid={item.testid}
							onClick={(e) => { e.stopPropagation(); setOpen(false); item.onSelect(); }}
							className={`px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent ${item.destructive ? "text-destructive" : "text-foreground"}`}>
							{item.label}
						</button>
					))}
				</span>
			)}
		</span>
	);
}
