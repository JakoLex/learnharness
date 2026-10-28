import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * THE PROJECTS STORE (projects wave, owner-approved 2026-10-28): a user's
 * separate workspaces, OpenScience-style — each project owns its chats,
 * knowledge graph, jobs and debug records under
 * <userRoot>/projects/prj_<id>/, with a small project.json beside them.
 * Settings and prompt overrides stay per user (the user root).
 *
 * Every function takes the user root explicitly: the request scope is
 * built FROM this store (src/server/scope.ts), so it cannot read it.
 */

export interface ProjectRecord {
	id: string;
	name: string;
	createdAt: string;
	/** Set while archived: hidden from the list, data kept (restorable). */
	archivedAt?: string;
}

/** A project as the list shows it. */
export interface ProjectSummary extends ProjectRecord {
	chatCount: number;
	/** Last real work: the newest chat/graph write, else creation. */
	activityAt: string;
}

const PROJECT_ID = /^prj_[a-z0-9-]+$/;
const MAX_NAME = 120;

export function isProjectId(id: string): boolean {
	return PROJECT_ID.test(id);
}

export function projectsDir(userRoot: string): string {
	return path.join(userRoot, "projects");
}

/** The project's data root (validated id — never a path escape). */
export function projectRootFor(userRoot: string, id: string): string {
	if (!isProjectId(id)) throw new Error(`Invalid project id: ${id}`);
	return path.join(projectsDir(userRoot), id);
}

function recordFile(userRoot: string, id: string): string {
	return path.join(projectRootFor(userRoot, id), "project.json");
}

/** A trimmed, non-empty, bounded name — or null when unusable. */
export function cleanProjectName(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const name = raw.replace(/\s+/g, " ").trim();
	return name && name.length <= MAX_NAME ? name : null;
}

export function getProject(userRoot: string, id: string): ProjectRecord | null {
	if (!isProjectId(id)) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(recordFile(userRoot, id), "utf-8")) as Partial<ProjectRecord>;
		if (typeof raw.name !== "string" || typeof raw.createdAt !== "string") return null;
		return {
			id,
			name: raw.name,
			createdAt: raw.createdAt,
			...(typeof raw.archivedAt === "string" ? { archivedAt: raw.archivedAt } : {}),
		};
	} catch {
		return null;
	}
}

function writeProject(userRoot: string, record: ProjectRecord): void {
	const file = recordFile(userRoot, record.id);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	fs.writeFileSync(tmp, JSON.stringify(record, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
}

export function createProject(userRoot: string, name: string): ProjectRecord {
	const record: ProjectRecord = {
		id: `prj_${crypto.randomUUID()}`,
		name,
		createdAt: new Date().toISOString(),
	};
	writeProject(userRoot, record);
	return record;
}

export function renameProject(userRoot: string, id: string, name: string): ProjectRecord | null {
	const record = getProject(userRoot, id);
	if (!record) return null;
	const next = { ...record, name };
	writeProject(userRoot, next);
	return next;
}

export function setProjectArchived(userRoot: string, id: string, archived: boolean): ProjectRecord | null {
	const record = getProject(userRoot, id);
	if (!record) return null;
	const { archivedAt: _was, ...rest } = record;
	const next: ProjectRecord = archived ? { ...rest, archivedAt: new Date().toISOString() } : rest;
	writeProject(userRoot, next);
	return next;
}

/** Delete a project with everything in it. False when it does not exist. */
export function deleteProject(userRoot: string, id: string): boolean {
	if (!getProject(userRoot, id)) return false;
	fs.rmSync(projectRootFor(userRoot, id), { recursive: true, force: true });
	return true;
}

/** Newest mtime among a directory's files (non-recursive), or 0. */
function newestIn(dir: string): number {
	let newest = 0;
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			newest = Math.max(newest, fs.statSync(path.join(dir, entry.name)).mtimeMs);
		}
	} catch {
		// absent dir: no activity there
	}
	return newest;
}

export function summarizeProject(userRoot: string, record: ProjectRecord): ProjectSummary {
	const root = projectRootFor(userRoot, record.id);
	let chatCount = 0;
	try {
		chatCount = fs.readdirSync(path.join(root, "chats")).filter((f) => f.endsWith(".json")).length;
	} catch {
		chatCount = 0;
	}
	const newest = Math.max(newestIn(path.join(root, "chats")), newestIn(path.join(root, "graph")));
	return { ...record, chatCount, activityAt: newest > 0 ? new Date(newest).toISOString() : record.createdAt };
}

/** Every project of the user, most recent activity first. */
export function listProjects(userRoot: string): ProjectSummary[] {
	let ids: string[] = [];
	try {
		ids = fs.readdirSync(projectsDir(userRoot)).filter(isProjectId);
	} catch {
		ids = [];
	}
	const out: ProjectSummary[] = [];
	for (const id of ids) {
		const record = getProject(userRoot, id);
		if (record) out.push(summarizeProject(userRoot, record));
	}
	return out.sort((a, b) => b.activityAt.localeCompare(a.activityAt));
}

/** The pre-projects record dirs a user root may still hold (legacy flat layout). */
export const LEGACY_PROJECT_DIRS = ["chats", "graph", "jobs", "debug"] as const;

/**
 * ONE-TIME MIGRATION (owner, 2026-10-28): a user root still holding the
 * flat pre-projects layout (chats/, graph/, jobs/, debug/ beside
 * settings.json) gets those records moved into a new project named `name`.
 * Same-filesystem renames — nothing is copied or rewritten. Returns the
 * created project, or null when there was nothing to move.
 */
export function migrateLegacyLayout(userRoot: string, name: string): ProjectRecord | null {
	const present = LEGACY_PROJECT_DIRS.filter((dir) => fs.existsSync(path.join(userRoot, dir)));
	if (present.length === 0) return null;
	const project = createProject(userRoot, name);
	const root = projectRootFor(userRoot, project.id);
	for (const dir of present) fs.renameSync(path.join(userRoot, dir), path.join(root, dir));
	console.info(`[projects] moved ${present.join(", ")} into project "${name}" (${project.id})`);
	return project;
}
