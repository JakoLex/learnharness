import * as fs from "node:fs";
import * as path from "node:path";
import { currentScope, userRoot } from "../../config.ts";
import { runInDataScope } from "../store/data-scope.ts";
import {
	cleanProjectName,
	createProject,
	deleteProject,
	getProject,
	listProjects,
	projectRootFor,
	renameProject,
	setProjectArchived,
	type ProjectRecord,
	type ProjectSummary,
} from "../store/projects.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { compactionInFlight } from "./compaction.ts";

/**
 * THE USER'S PROJECTS (projects wave, owner-approved 2026-10-28): the
 * project list's server side, always for the scoped user. Projects can be
 * created, renamed, archived/restored and deleted (owner's list — no
 * pinning).
 */

export type { ProjectRecord, ProjectSummary };

export function projectsOfUser(): ProjectSummary[] {
	return listProjects(userRoot());
}

export type ProjectResult =
	| { ok: true; project: ProjectRecord }
	| { ok: false; status: number; code: string; error: string };

const invalidName: ProjectResult = { ok: false, status: 400, code: "invalid_name", error: "A project needs a name (up to 120 characters)." };
const notFound: ProjectResult = { ok: false, status: 404, code: "project_not_found", error: "This project does not exist." };

export function createUserProject(rawName: unknown): ProjectResult {
	const name = cleanProjectName(rawName);
	if (!name) return invalidName;
	return { ok: true, project: createProject(userRoot(), name) };
}

/** Rename and/or archive/restore. */
export function updateUserProject(id: string, patch: { name?: unknown; archived?: unknown }): ProjectResult {
	const root = userRoot();
	if (!getProject(root, id)) return notFound;
	let project: ProjectRecord | null = null;
	if (patch.name !== undefined) {
		const name = cleanProjectName(patch.name);
		if (!name) return invalidName;
		project = renameProject(root, id, name);
	}
	if (patch.archived !== undefined) {
		if (typeof patch.archived !== "boolean") {
			return { ok: false, status: 400, code: "invalid_archived", error: "archived must be true or false." };
		}
		project = setProjectArchived(root, id, patch.archived);
	}
	if (!project) return { ok: false, status: 400, code: "empty_patch", error: "Nothing to change." };
	return { ok: true, project };
}

/** Whether anything still runs in the project: a turn, a compaction, an
 *  extraction, or a sub-agent job. Deleting under running work would let
 *  it write into a removed project. */
function workRunning(project: ProjectRecord): boolean {
	const scope = currentScope();
	return runInDataScope({ ...scope, project: { id: project.id, root: projectRootFor(scope.userRoot, project.id) } }, () => {
		if (extractionStatuses().length > 0) return true;
		for (const chat of stores.chatStore.listChats()) {
			if (isTurnRunning(chat.id) || compactionInFlight(chat.id)) return true;
			if (stores.jobStore.listJobs(chat.id).some((job) => job.status === "running")) return true;
		}
		return false;
	});
}

export function deleteUserProject(id: string): ProjectResult {
	const project = getProject(userRoot(), id);
	if (!project) return notFound;
	if (workRunning(project)) {
		return { ok: false, status: 409, code: "project_busy", error: "Something is still running in this project — try again when it finishes." };
	}
	deleteProject(userRoot(), id);
	return { ok: true, project };
}

/** The user's project holding a chat (old /chat/<id> links), or null. */
export function projectOfChat(chatId: string): string | null {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) return null;
	for (const project of listProjects(userRoot())) {
		if (fs.existsSync(path.join(projectRootFor(userRoot(), project.id), "chats", `${chatId}.json`))) return project.id;
	}
	return null;
}
