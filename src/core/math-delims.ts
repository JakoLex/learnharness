/** Shared Markdown/TeX boundaries for legacy delimiter compatibility and
 * display-only tool-content recovery. Source arguments are never rewritten. */
import {
	canParseTex, knownTexCommand, mapMathContent, numericPercentEscape, outsideTexComments,
	readContentSpans, recoverDocumentLayout, texRanges,
} from "./content-reader.ts";

const escaped = (text: string, i: number) => {
	let n = 0; while (i > 0 && text[--i] === "\\") n++;
	return n % 2 === 1;
};

/** Preserve the legacy list-continuation policy: indented display math
 * degrades to inline rather than disrupting list structure. Literal code
 * indentation is already protected by the shared reader. */
function indented(text: string, i: number): boolean {
	const prefix = text.slice(text.lastIndexOf("\n", i - 1) + 1, i);
	return prefix.length > 0 && /^[ \t]+$/.test(prefix);
}
function blockPosition(text: string, i: number): boolean {
	return /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i));
}

/** micromark closes native single-dollar spans at escaped dollars too.
 * Replace an intended literal dollar with equivalent dollar-free TeX before
 * tokenization. Code, prose, unbalanced spans and display dollars stay raw. */
function replaceEscapedDollars(content: string): string {
	let out = "";
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\\" && content[i + 1] === "$" && !escaped(content, i)) {
			out += "\\text{\\textdollar}"; i++;
		} else out += content[i];
	}
	return out;
}

/** Read old \(...\)/\[...\] syntax without touching literal content or
 * reparsing native math as Markdown. Dollar authoring remains native. */
export function transformMathDelimiters(markdown: string): string {
	let offset = 0;
	return readContentSpans(markdown).map(span => {
		const start = offset; offset += span.raw.length;
		if (span.kind !== "math") return span.raw;
		if (span.open === "$") return "$" + replaceEscapedDollars(span.body) + span.close;
		if (span.open !== "\\(" && span.open !== "\\[") return span.raw;
		const body = span.body.trim();
		if (!body) return span.raw;
		if (span.open === "\\(") return `$$${body}$$`;
		if (indented(markdown, start)) return `$$${body.replace(/\s*\n\s*/g, " ")}$$`;
		const before = blockPosition(markdown, start) ? "" : "\n\n";
		const end = start + span.raw.length;
		const after = end === markdown.length || markdown[end] === "\n" ? "" : "\n\n";
		return `${before}$$\n${body}\n$$${after}`;
	}).join("");
}

const DEBRIS: Record<string, string> = {
	"\b": "\\b", "\t": "\\t", "\v": "\\v", "\f": "\\f", "\r": "\\r",
};

/** Recover JSON-swallowed command prefixes only in recognized math, never
 * in code or genuine TeX comments. Restore all debris in one pass. Physical
 * display newlines and CRLF remain source whitespace. Inline LF recovery is
 * limited to complete known n-command names. Under the approved typical-
 * model-authoring policy this includes newline+u→nu in inline math only;
 * already-correct commands are never decoded into whitespace. */
export function restoreMathEscapes(text: string): string {
	if (!/[\b\t\n\v\f\r]/.test(text)) return text;
	return mapMathContent(text, (body, display) => outsideTexComments(body, part => {
		const restored = part.replace(/[\b\t\v\f\r]/g, (char, offset: number) => {
			if (char === "\r" && part[offset + 1] === "\n") return char;
			const suffix = /^[A-Za-z]+/.exec(part.slice(offset + 1))?.[0];
			return suffix && knownTexCommand(DEBRIS[char]!.slice(1) + suffix) ? DEBRIS[char]! : char;
		});
		if (display) return restored;
		return restored.replace(/\n([A-Za-z]+)/g, (whole, suffix: string) =>
			knownTexCommand("n" + suffix) ? "\\n" + suffix : whole);
	}));
}

const commandSymbol = /[,;:!|{}%]/;

/** Decode prefixes and row separators according to ORIGINAL TeX context.
 * A native pair is literal; an encoded pair supplies a factor, so an encoded
 * four-backslash row becomes TWO, never a command prefix. Unknown commands
 * without that structural evidence are left alone. */
function recoverCommandRuns(inner: string, display: boolean): string {
	const ranges = texRanges(inner);
	const recovered = inner.replace(/\\+/g, (run: string, offset: number) => {
		const contexts = ranges.filter(r => offset >= r.start && offset < r.end);
		if (contexts.some(r => r.kind === "row" || r.kind === "comment") || run.length % 2 !== 0) return run;
		const next = inner[offset + run.length] ?? "";
		const encoded = contexts.filter(r => r.kind === "encoded").at(-1);
		const word = /^[A-Za-z]+/.exec(inner.slice(offset + run.length))?.[0];
		if (encoded) {
			const factor = encoded.factor!;
			const rows = run.length % (2 * factor) === 0;
			const command = word ? knownTexCommand(word) : commandSymbol.test(next);
			if (run.length % factor === 0 && (rows || command)) return "\\".repeat(run.length / factor);
			return run;
		}
		if (next === "%") return numericPercentEscape(inner, offset + run.length) ? "\\" : run;
		if (word) return word.length > 1 && knownTexCommand(word) ? "\\" : run;
		return next && commandSymbol.test(next) ? "\\" : run;
	});
	// Structural evidence is primary (parse success cannot prove row
	// preservation). As an additional guard, never turn parseable source into
	// a parse failure through partial command recovery.
	if (recovered !== inner && !canParseTex(recovered, display) && canParseTex(inner, display)) return inner;
	return recovered;
}

export function healOverescapedCommands(text: string): string {
	return text.includes("\\\\") ? mapMathContent(text, recoverCommandRuns) : text;
}

/** Frame a display-math block whose fence is glued to the formula
 * (presentation-only, 2026-10-28): `$$` on its own line with the closing
 * `$$` written at the end of the last formula line is no Markdown math
 * fence, so the dollars reached KaTeX as TeX and the whole block rendered
 * as a parse error; an opener written on the first formula line turns
 * that line into the fence's (dropped) meta. Same framing
 * recoverDocumentLayout applies after decoding escapes, here for natively
 * authored text: both fences on their own lines (an indented opener's
 * indentation carries to the closer), the block set apart from the text
 * after it. Complete fences, single-line `$$…$$` and code stay untouched;
 * a block that never closes before a blank line stays as written. */
export function frameDisplayMath(text: string): string {
	if (!text.includes("$$")) return text;
	return readContentSpans(text).map((span) => {
		if (span.kind === "prose") return frameGluedClosers(span.raw);
		// Only the reader's FLOW blocks (multi-line display) — never inline $$…$$.
		if (span.kind !== "math" || !span.display || !span.body.includes("\n") || /^[ \t]*\r?\n/.test(span.body)) return span.raw;
		// The reader's flow block with content on the opener line.
		return `${span.open}\n${span.body.replace(/\r?\n[ \t]*$/, "")}\n${span.close}`;
	}).join("");
}

const FENCE_LINE = /^[ \t]{0,3}\$+[ \t]*\r?$/;
/** A line ending in an unescaped dollar run (group 1). */
const GLUED_END = /(?<![\\$])(\$+)[ \t]*\r?$/;

/** Prose lines: an opener-only `$$` line, formula lines, and a last line
 * ENDING in the same dollar run (before any blank line) → framed. */
function frameGluedClosers(prose: string): string {
	const lines = prose.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const opener = /^([ \t]{0,3})(\${2,})[ \t]*\r?$/.exec(lines[i]!);
		if (!opener) {
			out.push(lines[i]!);
			continue;
		}
		const [, indent, run] = opener;
		let closeAt = -1;
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j]!;
			if (/^[ \t]*\r?$/.test(line)) break; // a blank line ends the attempt
			if (FENCE_LINE.test(line)) break; // a real closer: Markdown has it
			const end = GLUED_END.exec(line);
			const glued = end && end[1]!.length === run!.length ? end : null;
			if (glued) {
				closeAt = j;
				lines[j] = line.slice(0, glued.index).replace(/[ \t]+$/, "");
				break;
			}
		}
		if (closeAt < 0) {
			out.push(lines[i]!);
			continue;
		}
		out.push(...lines.slice(i, closeAt + 1), `${indent}${run}`);
		// Set the block apart from text that follows on the next line.
		const after = lines[closeAt + 1];
		if (after !== undefined && !/^[ \t]*\r?$/.test(after)) out.push("");
		i = closeAt;
	}
	return out.join("\n");
}

/** Presentation-only, language-independent recovery. Shape parsing, saved
 * identities, grading and model history must use the unprojected source. */
export function repairMathForDisplay(text: string): string {
	return frameDisplayMath(healOverescapedCommands(restoreMathEscapes(recoverDocumentLayout(text))));
}
