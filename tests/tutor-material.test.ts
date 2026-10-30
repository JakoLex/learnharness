/**
 * The tutor's map and material (owner, 2026-10-30): list_propositions with
 * statements + the chains concluding in the session, search_graph,
 * read_source over the texts imports keep (only sources that still have
 * propositions), the three agents' registries, the store seam, and the
 * submit agent's one transient retry.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts/graph.ts";
import type { PiEngine } from "../src/agent/models.ts";

const testData = fs.mkdtempSync(join(tmpdir(), "lh-tutor-material-"));
process.env.LH_DATA_DIR = testData;
process.env.LH_AUTH_FILE = join(testData, "auth.json");
const { proberGraphTools } = await import("../src/agent/tools/graph.ts");
const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");
const { runSubmitAgent, submitRetry } = await import("../src/agent/subagents/submit-agent.ts");
const { graphStore: realGraphStore } = await import("../src/store/graph.ts");

after(() => fs.rmSync(testData, { recursive: true, force: true }));

// ─── fixtures ────────────────────────────────────────────────────────────────

const node = (id: string, name: string, born: string, statement = `statement of ${name}`): GraphNode => ({
	id,
	name,
	statement,
	aliases: [],
	createdAt: "2026-10-29T20:00:00.000Z",
	provenance: [{ chatId: born, messageId: "" }],
});
const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id,
	premises,
	conclusion,
	provenance: [{ chatId: "x", messageId: "" }],
	createdAt: "2026-10-29T20:00:00.000Z",
});

const SCRIPT = [
	"--- Page 1 ---",
	"## Der Oszillograph",
	"Die Zeitablenkung erzeugt eine Sägezahnspannung.",
	"",
	"--- Page 2 ---",
	"## Triggerung",
	"Der Trigger startet den Sägezahn am selben Phasenpunkt.",
].join("\n");

function stores(texts: Record<string, string> = {}, opts: { keepsTexts?: boolean } = {}) {
	const nodes = [
		node("n_saw", "Sägezahn als Zeitachse", "src_osc", "Die x-Ablenkung ist eine linear ansteigende Sägezahnspannung."),
		node("n_trig", "Triggerung", "src_osc", "Der Trigger startet jede Ablenkung am selben Punkt der Signalphase."),
		node("n_still", "Stehendes Bild", "src_osc", "Beginnt jede Ablenkung an derselben Phase, steht das Bild."),
		node("n_piezo", "Piezoeffekt", "src_piezo"),
		node("n_chat", "Lissajous-Figuren", "chat_1"),
	];
	const chains = [chain("arg_1", ["n_saw", "n_trig"], "n_still"), chain("arg_2", ["n_saw"], "n_piezo")];
	const sources = [
		{ id: "src_osc", filePath: "oscilloscope-script.pdf", importedAt: "2026-10-29T20:43:46.420Z" },
		{ id: "src_piezo", filePath: "piezo-datasheet.pdf", importedAt: "2026-10-29T20:43:41.468Z" },
		// Imported, text kept, but every proposition deleted.
		{ id: "src_gone", filePath: "scope-manual.pdf", importedAt: "2026-10-29T20:51:01.503Z" },
	];
	const graphStore = {
		readNodes: () => nodes,
		readChains: () => chains,
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () => sources,
		...(opts.keepsTexts === false ? {} : { readSourceText: (id: string) => texts[id] ?? null }),
	} as unknown as GraphStore;
	const chatStore = {
		listChats: () => [{ id: "chat_1", title: "Lab prep", createdAt: "2026-10-29T22:14:21.995Z", updatedAt: "2026-10-29T22:32:41.324Z" }],
		getChat: () => null,
	} as unknown as ChatStore;
	return { chatStore, graphStore };
}

const text = async (tool: { execute?: (id: string, input: never) => Promise<{ details: unknown }> } | undefined, input: unknown) =>
	(await tool!.execute!("tc", input as never)).details as string;

// ─── list_propositions + search_graph ───────────────────────────────────────

describe("list_propositions — statements and chains (fork, 2026-10-30)", () => {
	it("each proposition with its statement, then the chains whose conclusion was born here", async () => {
		const tools = proberGraphTools(stores());
		const out = await text(tools.list_propositions, { session: "src_osc" });
		assert.match(out, /^3 proposition\(s\) covered in this session:/);
		assert.match(out, /- Sägezahn als Zeitachse \[n_saw\]: Die x-Ablenkung ist eine linear ansteigende Sägezahnspannung\./);
		assert.match(out, /1 chain\(s\) concluding in this session:\n- Sägezahn als Zeitachse ∧ Triggerung ⟹ Stehendes Bild/);
		// arg_2 concludes in the Piezo session — it is listed there, not here.
		assert.doesNotMatch(out, /⟹ Piezoeffekt/);
		const piezo = await text(tools.list_propositions, { session: "src_piezo" });
		assert.match(piezo, /- Sägezahn als Zeitachse ⟹ Piezoeffekt/);
	});

	it("a session too long for one answer is cut at 50 KB with a pointer to search_graph", async () => {
		const many = Array.from({ length: 400 }, (_, i) => node(`n_${i}`, `Satz ${i}`, "src_big", "x".repeat(300)));
		const graphStore = { readNodes: () => many, readChains: () => [], readSources: () => [] } as unknown as GraphStore;
		const out = await text(proberGraphTools({ chatStore: stores().chatStore, graphStore }).list_propositions, { session: "src_big" });
		assert.ok(Buffer.byteLength(out) <= 51 * 1024, "within the cap");
		assert.match(out, /\[\d+ more line\(s\) not shown — narrow with search_graph\]$/);
	});
});

describe("search_graph", () => {
	it("globs names and statements across the whole map, naming each hit's session", async () => {
		const tools = proberGraphTools(stores());
		const out = await text(tools.search_graph, { query: "sägezahn" });
		assert.match(out, /^1 match\(es\):/);
		assert.match(out, /- Sägezahn als Zeitachse \[n_saw\] — from oscilloscope-script\.pdf: Die x-Ablenkung/);
		const byStatement = await text(tools.search_graph, { query: "*Signalphase*" });
		assert.match(byStatement, /Triggerung \[n_trig\]/);
		const chat = await text(tools.search_graph, { query: "Lissajous" });
		assert.match(chat, /— from Lab prep:/);
		assert.equal(await text(tools.search_graph, { query: "Quantenchromodynamik" }), 'No proposition matches "Quantenchromodynamik".');
	});
});

// ─── read_source ─────────────────────────────────────────────────────────────

describe("read_source", () => {
	const texts = { src_osc: SCRIPT, src_gone: "--- Page 1 ---\nUser manual" };

	it("no arguments: the readable sources — kept text AND propositions left", async () => {
		const out = await text(proberGraphTools(stores(texts)).read_source, {});
		assert.match(out, /^1 readable source\(s\):\n- oscilloscope-script\.pdf — id: src_osc, 7 lines$/);
	});

	it("reads a source like read, with offset/limit", async () => {
		const tools = proberGraphTools(stores(texts));
		const all = await text(tools.read_source, { source: "src_osc" });
		assert.ok(all.startsWith("oscilloscope-script.pdf\n\n--- Page 1 ---\n## Der Oszillograph"));
		const slice = await text(tools.read_source, { source: "src_osc", offset: 5, limit: 2 });
		assert.match(slice, /--- Page 2 ---\n## Triggerung/);
		assert.doesNotMatch(slice, /Der Oszillograph/);
		assert.match(slice, /Use offset=7 to continue/);
	});

	it("query: the matching lines with line and page numbers", async () => {
		const out = await text(proberGraphTools(stores(texts)).read_source, { source: "src_osc", query: "SÄGEZAHN" });
		assert.equal(
			out,
			"2 matching line(s) in oscilloscope-script.pdf:\n" +
				"- line 3 (page 1): Die Zeitablenkung erzeugt eine Sägezahnspannung.\n" +
				"- line 7 (page 2): Der Trigger startet den Sägezahn am selben Phasenpunkt.",
		);
		assert.equal(await text(proberGraphTools(stores(texts)).read_source, { source: "src_osc", query: "Lissajous" }), 'No line of oscilloscope-script.pdf contains "Lissajous".');
	});

	it("refuses a source whose propositions were all deleted, one without kept text, and a chat id", async () => {
		const tools = proberGraphTools(stores(texts));
		for (const source of ["src_gone", "src_piezo", "chat_1", "../../auth"]) {
			assert.match(await text(tools.read_source, { source }), /is not readable — .*Call read_source with no arguments/, source);
		}
	});

	it("absent when the store keeps no texts (test fakes, older stores)", () => {
		const tools = proberGraphTools(stores(texts, { keepsTexts: false }));
		assert.equal("read_source" in tools, false);
		assert.ok(tools.search_graph);
	});
});

// ─── the three registries ────────────────────────────────────────────────────

describe("registries: prober, teacher and practice all carry the map + material set", () => {
	const jobStore = { createJob: () => ({}), getJob: () => undefined, listJobs: () => [], updateJob: () => {} } as unknown as JobStore;
	const MAP = ["list_propositions", "list_sessions", "read_source", "search_graph"];

	it("each agent gets the four readers when its graph root is passed, none without", () => {
		const { chatStore, graphStore } = stores({ src_osc: SCRIPT });
		const prober = createProberTools({ chatId: "c1", chatStore, deliver: () => {}, jobStore, spawn: () => {}, graphStore });
		const teacher = createTeacherTools({ chatId: "c1", chatStore, jobStore, spawn: () => {}, graphStore });
		const practice = practiceTools({ chatId: "c1", chatStore: { getChat: () => null }, graph: { chatStore, graphStore } });
		for (const [name, tools] of Object.entries({ prober, teacher, practice })) {
			for (const tool of MAP) assert.ok(tool in tools, `${name} has ${tool}`);
		}
		const bareTeacher = createTeacherTools({ chatId: "c1", chatStore, jobStore, spawn: () => {} });
		for (const tool of MAP) assert.equal(tool in bareTeacher, false, `closed gate: no ${tool}`);
	});
});

// ─── the store seam ──────────────────────────────────────────────────────────

describe("graph store: kept source texts", () => {
	it("writes and reads per source id, replacing on re-import; never a path outside the graph", () => {
		assert.equal(realGraphStore.readSourceText!("src_abc123"), null);
		realGraphStore.writeSourceText!("src_abc123", "erste Fassung");
		realGraphStore.writeSourceText!("src_abc123", "--- Page 1 ---\nzweite Fassung");
		assert.equal(realGraphStore.readSourceText!("src_abc123"), "--- Page 1 ---\nzweite Fassung");
		assert.ok(fs.existsSync(join(testData, "graph", "source-text", "src_abc123.md")));
		assert.throws(() => realGraphStore.writeSourceText!("../evil", "x"), /not a source id/);
		assert.equal(realGraphStore.readSourceText!("../auth"), null);
	});
});

// ─── the submit agent's one retry ────────────────────────────────────────────

describe("runSubmitAgent: one retry after a transient break (owner, 2026-10-30)", () => {
	const engineOf = (steps: FauxResponseStep[]): PiEngine => {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	};
	const broke = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "Stream ended without finish_reason" });
	const submits = () => fauxAssistantMessage([fauxToolCall("submit", { value: 42 }, { id: "s1" })], { stopReason: "toolUse" });
	const run = (engine: PiEngine, signal?: AbortSignal) =>
		runSubmitAgent<number>({
			role: "extractor",
			chatId: "src_test",
			toolName: "submit",
			toolDescription: "Submit the value.",
			parameters: Type.Object({ value: Type.Number() }),
			fill: (input: { value: number }) => input.value,
			systemPrompt: "Submit 42.",
			prompt: "Go.",
			engine,
			signal,
			onStep: () => {},
			neverSubmitted: "never submitted",
		});
	const warnings: string[] = [];
	const originalWarn = console.warn;
	const capture = () => {
		warnings.length = 0;
		console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
	};
	afterEach(() => {
		console.warn = originalWarn;
		submitRetry.delayMs = 30_000;
	});

	it("a stream cut mid-answer is retried once, logged, and the retry's submit counts", async () => {
		submitRetry.delayMs = 5;
		capture();
		assert.equal(await run(engineOf([broke(), submits()])), 42);
		assert.deepEqual(warnings, ["[extraction src_test] extractor broke off (Stream ended without finish_reason) — retrying once in 0 s"]);
	});

	it("a second break throws — one retry, not a loop", async () => {
		submitRetry.delayMs = 5;
		capture();
		await assert.rejects(run(engineOf([broke(), broke(), submits()])), /Stream ended without finish_reason/);
		assert.equal(warnings.length, 1);
	});

	it("a non-transient failure is not retried", async () => {
		submitRetry.delayMs = 5;
		capture();
		const refused = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 bad request: invalid tool schema" });
		await assert.rejects(run(engineOf([refused(), submits()])), /invalid tool schema/);
		assert.equal(warnings.length, 0);
	});

	it("an abort during the wait ends it as an abort", async () => {
		submitRetry.delayMs = 10_000;
		capture();
		const controller = new AbortController();
		const pending = run(engineOf([broke(), submits()]), controller.signal);
		setTimeout(() => controller.abort(), 20);
		await assert.rejects(pending, (err: Error) => err.name === "AbortError");
	});
});
