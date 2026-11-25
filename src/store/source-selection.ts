import fs from "node:fs";
import path from "node:path";
import { sourceSelectionFile } from "../../config.ts";
import { emptySourceInclusion, parseSourceInclusion } from "../core/source-inclusion.ts";
import type { SourceSelectionStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

/** Fork (owner, 2026-11-25): graph/source-selection.json — only the
 *  switched-off ids. A missing file means everything is on. */
export const sourceSelectionStore: SourceSelectionStore = {
	read() {
		assertGraphFormat();
		let raw: string;
		try { raw = fs.readFileSync(sourceSelectionFile(), "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySourceInclusion();
			throw error;
		}
		return parseSourceInclusion(JSON.parse(raw));
	},
	write(state) {
		assertGraphFormat();
		const valid = parseSourceInclusion(state);
		fs.mkdirSync(path.dirname(sourceSelectionFile()), { recursive: true });
		ensureGraphFormat();
		writeFileAtomicSync(sourceSelectionFile(), JSON.stringify(valid, null, "\t") + "\n");
		removeLeftoverTemps(sourceSelectionFile());
		emit("sources-changed", {});
	},
};
