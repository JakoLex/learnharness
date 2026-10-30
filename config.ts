import path from "node:path";
import { fileURLToPath } from "node:url";
import { activeDataScope, type DataScope } from "./src/store/data-scope.ts";

/** Re-exported for the agent layer, which never imports src/store. */
export { runUnscoped } from "./src/store/data-scope.ts";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE data-location seam (the Electron contract, 2026-09-17): LH_DATA_DIR
 * relocates every MUTABLE record — chat sessions, graph ledgers, the
 * embedding model cache — when set. The desktop shell points it at
 * userData so nothing is written inside the read-only .app bundle
 * (macOS translocation guarantees the bundle is read-only anyway).
 * Unset (plain web dev / repo work) it resolves to the repo's data/,
 * byte-for-byte as before. Read-only assets (prompts) stay ROOT-anchored
 * on purpose: they ship inside the app bundle by design.
 */
const DATA_ROOT = process.env.LH_DATA_DIR
	? path.resolve(process.env.LH_DATA_DIR)
	: path.join(ROOT, "data");

// ─── The data scope (projects wave, owner-approved 2026-10-28) ──────────────
// DATA_ROOT is the BASE: it holds the accounts and the per-user roots.
// Every mutable record below resolves through the running code's DataScope
// (src/store/data-scope.ts): user-level files (settings, prompt overrides)
// under the user root, project-level records (chats, graph, jobs, debug)
// under the project root. Layout:
//   local mode:    <base>/settings.json, <base>/projects/prj_<id>/{chats,graph,jobs,debug}
//   accounts mode: <base>/users/<userId>/… (same shape per user)

/** Unscoped access gets the legacy FLAT layout (user root = project root =
 *  base) under tests and the explicit LH_FLAT_DATA=1 escape hatch only —
 *  decided once at load (a test flipping NODE_ENV mid-run keeps its
 *  fixtures). A running server refuses loudly instead: code that lost its
 *  scope must never read or write a ghost location. `allowed` is the test
 *  seam for pinning the refusal. */
export const flatFallback = {
	allowed: process.env.NODE_ENV === "test" || process.env.LH_FLAT_DATA === "1",
};

/** The running code's scope (see flatFallback for unscoped code). */
export function currentScope(): DataScope {
	const scope = activeDataScope();
	if (scope) return scope;
	if (flatFallback.allowed) {
		return { userId: "local", admin: true, userRoot: DATA_ROOT, project: { id: "flat", root: DATA_ROOT } };
	}
	throw new Error("No data scope: user/project data was accessed outside a scoped request");
}

/** The scoped user's root (settings.json, prompts/, projects/). */
export function userRoot(): string {
	return currentScope().userRoot;
}

/** The scoped project's root (chats/, graph/, jobs/, debug/). */
export function projectRoot(): string {
	const project = currentScope().project;
	if (!project) throw new Error("No project in scope: project data was accessed by a user-level request");
	return project.root;
}

export const PATHS = {
	root: ROOT,
	/** Teacher system prompt — the agent's instructions (src/agent/). */
	teacherPrompt: path.join(ROOT, "src", "agent", "system-prompt.md"),
	/** The data BASE (LH_DATA_DIR): accounts and per-user roots live here. */
	data: DATA_ROOT,
	/** Chat sessions (one JSON file per chat) — the scoped project's. */
	get chats() {
		return path.join(projectRoot(), "chats");
	},
	get graph() {
		return path.join(projectRoot(), "graph");
	},
	/** Sub-agent job records — the scoped project's. */
	get jobs() {
		return path.join(projectRoot(), "jobs");
	},
	/** Debug artifacts (env-gated): <project>/debug/provider-events/<chatId>.jsonl
	 * raw provider stream recordings (src/agent/provider-events.ts). */
	get debug() {
		return path.join(projectRoot(), "debug");
	},
};

// ─── Models ────────────────────────────────────────────────────────────────
// BYOK ALL THE WAY DOWN (owner, 2026-09-22): there are NO factory default
// models. Every engine resolves from the user's model slots (settings.json
// models section: strong/cheap/vision) over per-role/ChatSettings overrides,
// and a chain that ends empty REFUSES honestly (503 models_not_configured).
// .env stays for secrets (API keys) only. What remains here are ENGINE
// CONSTRUCTION FACTS: the thinking-level scale and the default order.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every agent role in the app. The conversation pair (prober/teacher)
 *  resolves chat.model → strong slot; background roles resolve their own
 *  override → tier slot (core/settings-resolution.ts ROLE_SLOT). */
export type ModelRole =
	| "prober"
	| "teacher"
	| "researcher"
	| "demoBuilder"
	| "visualMaker"
	| "pdfReader"
	| "extractor"
	| "auditor";

/**
 * The LIVE graph store (src/store/graph.ts) — owned by the app's extraction
 * pipeline. Line shapes: src/core/contracts.ts. CHAINS ARE THE STORED
 * TRUTH (owner, 2026-09-30): edges are a derived view, never stored.
 */
export const LEDGER_FILES = {
	get nodes() {
		return path.join(PATHS.graph, "nodes.jsonl");
	},
	get chains() {
		return path.join(PATHS.graph, "chains.jsonl");
	},
	get sessions() {
		return path.join(PATHS.graph, "sessions.jsonl");
	},
	/** Per-message extraction coverage (contracts/graph.ts CoverageEntry;
	 *  the checkpoint's replacement for chat extractions — notes keep
	 *  sessions.jsonl, whole-file as they are). */
	get coverage() {
		return path.join(PATHS.graph, "coverage.jsonl");
	},
};

/**
 * Notes-import bookkeeping (NOT a ledger): one JSON map, src-id → NotesSource
 * record (contracts/graph.ts) — the file path + import time + the run's usage
 * log. Read-modify-write like a chat file, not append-only like the ledgers.
 */
export function sourcesFile(): string {
	return path.join(PATHS.graph, "sources.json");
}
/** Fork (owner, 2026-10-30): the text an import read, one file per source
 *  (`read_source`) — the doc loader's Markdown with page markers, the
 *  pdf.js text layer, or the notes file as it was. A re-import overwrites. */
export function sourceTextFile(id: string): string {
	return path.join(PATHS.graph, "source-text", `${id}.md`);
}
/** The layout ledger (read-modify-write like sources.json): nodeId →
 *  {x,y} resting positions from the incremental settle (core/layout.ts).
 *  Carries an updatedAt stamp for future live-physics conflict handling. */
export function positionsFile(): string {
	return path.join(PATHS.graph, "positions.json");
}

/**
 * Graph render settings (the settings-panel controls): one small JSON blob,
 * read-modify-write. Shared shape/sanitizer: src/core/render-settings.ts.
 */
export function renderSettingsFile(): string {
	return path.join(PATHS.graph, "render-settings.json");
}

/** The graph-family FORMAT STAMP sidecar (schema-versioning wave,
 *  2026-10-10): one version for the whole family — the four JSONL ledgers,
 *  sources.json, render-settings.json. LAZY v1: absent = v1; the first
 *  graph-family write creates it. positions.json is REBUILDABLE and rides
 *  along unversioned by design (owner ruling). */
export function graphFormatFile(): string {
	return path.join(PATHS.graph, "format.json");
}

/**
 * THE USER SETTINGS RECORD (settings-storage wave, 2026-09-19): one
 * versioned, DELTA-shaped JSON blob at the data-dir seam holding every
 * non-secret product preference — general, agent (background
 * model/thinking overrides + tool toggles + prompt-override switches),
 * appearance, graph. Explicit user choices only: ABSENT keys resolve to the
 * factory defaults compiled into src/core/settings.ts (FACTORY_SETTINGS), so
 * a software update that adds a knob (new tool, new role, new appearance
 * field) needs no migration — old records simply lack the new keys. The
 * version field is a PRIVATE schema counter for breaking shape changes
 * only (field renamed/meaning changed), unrelated to the app release
 * version. Secrets (API keys, login tokens) NEVER live here — auth.json /
 * .env.local keep that role. (The `chat` default-settings section died
 * with per-session models, owner 2026-09-28 — sessions own their model
 * from birth, stamped from the strong slot.)
 */
export function settingsFile(): string {
	return path.join(userRoot(), "settings.json");
}

/**
 * User prompt-override files (settings-storage wave, 2026-09-19): the
 * per-segment system-prompt overrides mirroring the SOURCE layout
 * (src/agent/prompts/) — the shared base as prompts/system-prompt.md,
 * fragments as prompts/teacher/<file> / prompts/prober/<file>. File
 * PRESENCE alone is not the override: settings.json's agent.prompts map
 * (segmentPath → boolean) is the explicit switch, so a user can keep a
 * customized file on disk but run the source default to compare. The
 * segment list itself is ALWAYS derived from source at runtime (the
 * loader in src/store/prompt-overrides.ts) — code updates that add,
 * remove, or reorder fragments adapt automatically; an override keyed to
 * a vanished segment stops composing but stays on disk.
 */
export function promptsOverrideDir(): string {
	return path.join(userRoot(), "prompts");
}

/**
 * THE AUTH/KEY STORE (auth-keys wave, 2026-09-19): BYOK provider keys in a
 * flat {VAR: value} JSON map — the SAME file the Electron app has always
 * hand-edited (owner decision: option A, zero migration). Desktop main.cjs
 * passes LH_AUTH_FILE pointing at userData/auth.json (mode 0600); in dev
 * (no Electron) the default is the repo-root auth.json (gitignored, same
 * pattern as .env.local — a worktree may symlink it to the master copy).
 * The SERVER reads/writes this file directly at call time (no restart to
 * change a key); it reflects the values into process.env at boot with
 * FILL-GAP precedence — real environment variables (incl. .env.local in
 * dev) always win (src/server/keys.ts). Hand-edits still work: the file is
 * re-read from disk on every API access. Secrets NEVER go in settings.json
 * — this file keeps that role, alongside .env.local.
 */
export const AUTH_FILE = process.env.LH_AUTH_FILE
	? path.resolve(process.env.LH_AUTH_FILE)
	: path.join(ROOT, "auth.json");
