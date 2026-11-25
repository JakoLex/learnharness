/**
 * PROGRESS BARS (fork, owner 2026-11-25): what the graph's import pill and
 * the shelf show under their status line — a fraction for the bar (null =
 * no numbers yet: the bar runs without a fill level) and a short line.
 *
 * Owner's decisions: reading through the doc loader restarts the bar per
 * loader step (step 1 Docling over all pages, step 2 the formula and image
 * pages); an import's extraction is ONE bar over its sections, each section
 * split by phase (extracting up to 60 %, auditing up to 90 %, merging to
 * 100 % — estimated shares; the line shows the exact section).
 *
 * Client-safe: no server imports. The loader fields mirror
 * src/agent/doc-loader.ts LoaderProgress.
 */

export interface LoaderProgressView {
	state: "waiting" | "running";
	phase?: string;
	page?: number;
	pages?: number;
	kind?: string;
	ahead?: number;
}

export interface Progress {
	/** 0..1, or null when there are no numbers (indeterminate bar). */
	fraction: number | null;
	text: string;
}

const ratio = (page?: number, pages?: number): number | null =>
	pages && pages > 0 && page !== undefined ? Math.min(1, Math.max(0, page / pages)) : null;

/** The doc loader's progress on one file. */
export function loaderProgress(p: LoaderProgressView | undefined): Progress {
	if (!p) return { fraction: null, text: "Reading the document" };
	if (p.state === "waiting") {
		const ahead = p.ahead ?? 0;
		return { fraction: null, text: ahead > 0 ? `Waiting for the doc loader (${ahead} ${ahead === 1 ? "file" : "files"} ahead)` : "Waiting for the doc loader" };
	}
	switch (p.phase) {
		case "docling":
		case "docling2": {
			const pass = p.phase === "docling2" ? " (2nd pass)" : "";
			const pages = p.pages ? ` · page ${p.page ?? 0}/${p.pages}` : "";
			return { fraction: ratio(p.page, p.pages), text: `Step 1/2 · Docling${pass}${pages}` };
		}
		case "seiten": {
			const now = p.kind === "formeln" ? " (formulas)" : p.kind === "bild" ? " (image page)" : "";
			return { fraction: ratio(p.page, p.pages), text: `Step 2/2 · formula & image pages ${p.page ?? 0}/${p.pages ?? "?"}${now}` };
		}
		case "libreoffice":
			return { fraction: null, text: "Converting the slides" };
		case "bild":
			return { fraction: null, text: "Reading the image" };
		default:
			return { fraction: null, text: "Reading the document" };
	}
}

/** Where a phase leaves its section (the owner's 60/30/10 split). */
const SECTION_START: Record<string, number> = {
	queued: 0,
	extracting: 0,
	waiting: 0.6,
	auditing: 0.6,
	merging: 0.9,
};

/** One pipeline run's bar: the loader's progress while reading, the
 *  sections afterwards. Null for phases without a measure (bridging). */
export function runProgress(run: { phase: string; part?: { i: number; n: number }; reading?: LoaderProgressView }): Progress | null {
	if (run.phase === "reading") return loaderProgress(run.reading);
	const start = SECTION_START[run.phase];
	if (start === undefined) return null;
	const n = run.part?.n ?? 1;
	const i = run.part?.i ?? 1;
	return { fraction: Math.min(1, (i - 1 + start) / n), text: n > 1 ? `Section ${i}/${n}` : "" };
}
