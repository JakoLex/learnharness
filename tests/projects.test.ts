import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { PATHS, currentScope, flatFallback, projectRoot, settingsFile } from "../config.ts";
import { activeDataScope, runInDataScope, runUnscoped, sameAudience, type DataScope } from "../src/store/data-scope.ts";
import {
	cleanProjectName,
	createProject,
	deleteProject,
	getProject,
	listProjects,
	migrateLegacyLayout,
	projectRootFor,
	renameProject,
	setProjectArchived,
} from "../src/store/projects.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { graphStore } from "../src/store/graph.ts";
import { readSettings, writeSettings } from "../src/store/settings.ts";
import { scoped, scopeFor, localUser, PROJECT_HEADER } from "../src/server/scope.ts";
import { deleteUserProject, projectOfChat } from "../src/server/projects.ts";
import { eventsResponse } from "../src/server/events-stream.ts";
import { emit } from "../src/core/events.ts";
import { extractionStatuses } from "../src/agent/subagents/extraction.ts";
import { apiUrlWithProject } from "../components/api-fetch.ts";
import { projectHref, projectIdFromPath } from "../components/project-paths.ts";
import { visibleProjects } from "../components/projects-home.tsx";
import { cameraStorageKey } from "../components/graph-view.tsx";

// Projects (projects wave, owner-approved 2026-10-28): each project owns
// its chats, graph, jobs and debug records under <userRoot>/projects/;
// settings stay per user; every request runs in its user/project scope.

const tmpRoots: string[] = [];
function tmpUserRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-projects-"));
	tmpRoots.push(dir);
	return dir;
}
after(() => {
	for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const user = (root: string): DataScope => ({ userId: "u1", admin: true, userRoot: root });
function inProject<T>(root: string, id: string, fn: () => T): T {
	return runInDataScope({ ...user(root), project: { id, root: projectRootFor(root, id) } }, fn);
}

describe("projects store", () => {
	it("creates, lists, renames, archives, restores and deletes", () => {
		const root = tmpUserRoot();
		const a = createProject(root, "Analysis");
		const b = createProject(root, "Mechanics");
		assert.match(a.id, /^prj_[a-z0-9-]+$/);
		assert.deepEqual(listProjects(root).map((p) => p.name).sort(), ["Analysis", "Mechanics"]);
		assert.equal(renameProject(root, a.id, "Real analysis")?.name, "Real analysis");
		assert.ok(setProjectArchived(root, b.id, true)?.archivedAt);
		assert.equal(setProjectArchived(root, b.id, false)?.archivedAt, undefined);
		assert.equal(deleteProject(root, b.id), true);
		assert.equal(getProject(root, b.id), null);
		assert.equal(fs.existsSync(projectRootFor(root, b.id)), false, "the project dir is gone with its data");
		assert.equal(deleteProject(root, b.id), false);
	});

	it("summaries count sessions; ids never escape the projects dir", () => {
		const root = tmpUserRoot();
		const p = createProject(root, "P");
		inProject(root, p.id, () => chatStore.createChat("hello"));
		assert.equal(listProjects(root)[0]!.chatCount, 1);
		assert.throws(() => projectRootFor(root, "../escape"));
		assert.equal(getProject(root, "../escape"), null);
	});

	it("names are trimmed, non-empty and bounded", () => {
		assert.equal(cleanProjectName("  Semester   3 "), "Semester 3");
		assert.equal(cleanProjectName("   "), null);
		assert.equal(cleanProjectName(42), null);
		assert.equal(cleanProjectName("x".repeat(121)), null);
	});

	it("the one-time migration moves the flat layout into its first project", () => {
		const root = tmpUserRoot();
		for (const dir of ["chats", "graph", "jobs"]) {
			fs.mkdirSync(path.join(root, dir));
			fs.writeFileSync(path.join(root, dir, "marker.json"), dir);
		}
		fs.writeFileSync(path.join(root, "settings.json"), "{}");
		const project = migrateLegacyLayout(root, "My project");
		assert.ok(project);
		assert.equal(project.name, "My project");
		const proot = projectRootFor(root, project.id);
		for (const dir of ["chats", "graph", "jobs"]) {
			assert.equal(fs.readFileSync(path.join(proot, dir, "marker.json"), "utf-8"), dir);
			assert.equal(fs.existsSync(path.join(root, dir)), false);
		}
		assert.ok(fs.existsSync(path.join(root, "settings.json")), "settings stay with the user");
		assert.equal(migrateLegacyLayout(root, "My project"), null, "nothing left to move");
	});
});

describe("data scope isolation", () => {
	it("chats, graph and jobs live per project; settings per user", () => {
		const root = tmpUserRoot();
		const a = createProject(root, "A");
		const b = createProject(root, "B");
		const chat = inProject(root, a.id, () => chatStore.createChat("only in A"));
		inProject(root, a.id, () => jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "t1" }));
		inProject(root, a.id, () =>
			graphStore.appendNode({ id: "n_a", name: "A idea", statement: "s", sources: [chat.id], createdAt: new Date().toISOString() } as never),
		);
		assert.equal(inProject(root, a.id, () => chatStore.listChats().length), 1);
		assert.equal(inProject(root, b.id, () => chatStore.listChats().length), 0, "B never sees A's chats");
		assert.equal(inProject(root, b.id, () => jobStore.listJobs(chat.id).length), 0);
		assert.equal(inProject(root, b.id, () => graphStore.readNodes().length), 0, "B has its own graph");
		inProject(root, a.id, () => writeSettings({ version: 1, general: { autoUpdate: false } }));
		assert.equal(inProject(root, b.id, () => readSettings()?.general?.autoUpdate), false, "settings are the user's");
		assert.equal(inProject(root, a.id, () => settingsFile()), path.join(root, "settings.json"));
	});

	it("unscoped access refuses outside tests (no ghost writes)", () => {
		flatFallback.allowed = false; // what a running server has
		try {
			assert.throws(() => currentScope(), /No data scope/);
			assert.throws(() => PATHS.chats, /No data scope/);
		} finally {
			flatFallback.allowed = true;
		}
		assert.throws(
			() => runInDataScope(user(tmpUserRoot()), () => projectRoot()),
			/No project in scope/,
			"user-level requests never reach project data",
		);
	});

	it("an extraction run is listed only in its own project", () => {
		const root = tmpUserRoot();
		const a = createProject(root, "A");
		const b = createProject(root, "B");
		const g = globalThis as { __lhExtractionRuns?: { running: Map<string, unknown>; inFlight: Set<string>; lastStartedAt: number } };
		const real = g.__lhExtractionRuns;
		const graphA = path.join(projectRootFor(root, a.id), "graph");
		g.__lhExtractionRuns = {
			running: new Map([[`${graphA}\u0000src_same`, { chatId: "src_same", kind: "notes", phase: "extracting", startedAt: 1, usage: {}, controller: new AbortController() }]]),
			inFlight: new Set(),
			lastStartedAt: 0,
		};
		try {
			assert.equal(inProject(root, a.id, () => extractionStatuses().length), 1);
			assert.equal(inProject(root, b.id, () => extractionStatuses().length), 0, "same source id, other project");
		} finally {
			g.__lhExtractionRuns = real;
		}
	});
});

describe("scoped routes", () => {
	const echo = scoped(async (_request: Request) => Response.json({ scope: activeDataScope() ?? null }), { project: "required" });
	const userLevel = scoped(async (_request: Request) => Response.json({ scope: activeDataScope() ?? null }), { project: "none" });
	const req = (headers: Record<string, string> = {}, url = "http://lh.test/api/x") => new Request(url, { headers });

	it("a named project runs the handler in that project's scope", async () => {
		const project = createProject(PATHS.data, "Scoped route");
		try {
			const body = (await (await echo(req({ [PROJECT_HEADER]: project.id }))).json()) as { scope: DataScope };
			assert.equal(body.scope.project?.id, project.id);
			assert.equal(body.scope.project?.root, projectRootFor(PATHS.data, project.id));
			const viaQuery = (await (await echo(req({}, `http://lh.test/api/events?project=${project.id}`))).json()) as { scope: DataScope };
			assert.equal(viaQuery.scope.project?.id, project.id, "EventSource names it in the query");
		} finally {
			deleteProject(PATHS.data, project.id);
		}
	});

	it("an unknown project is a 404; user-level routes ignore the selector", async () => {
		const res = await echo(req({ [PROJECT_HEADER]: "prj_missing" }));
		assert.equal(res.status, 404);
		assert.equal(((await res.json()) as { code: string }).code, "project_not_found");
		const project = createProject(PATHS.data, "Ignored");
		try {
			const body = (await (await userLevel(req({ [PROJECT_HEADER]: project.id }))).json()) as { scope: DataScope | null };
			assert.equal(body.scope?.project, undefined);
		} finally {
			deleteProject(PATHS.data, project.id);
		}
	});

	it("scopeFor builds the local user's project scope", () => {
		const project = { id: "prj_x", name: "X", createdAt: "" };
		assert.deepEqual(scopeFor(localUser(), project), {
			userId: "local",
			admin: true,
			userRoot: PATHS.data,
			project: { id: "prj_x", root: path.join(PATHS.data, "projects", "prj_x") },
		});
	});
});

describe("project-scoped events", () => {
	it("a window hears its project, user-wide and process-wide events — never another project's", async () => {
		const root = tmpUserRoot();
		const a = createProject(root, "A");
		const b = createProject(root, "B");
		const res = inProject(root, a.id, () => eventsResponse());
		const reader = res.body!.getReader();
		inProject(root, b.id, () => emit("chats-changed", {}));
		inProject(root, a.id, () => emit("turn-started", { chatId: "chat_a" }));
		runInDataScope(user(root), () => emit("subscriptions-changed", {}));
		runUnscoped(() => emit("activity-changed", {}));
		const text = new TextDecoder();
		let seen = "";
		while (!seen.includes("activity-changed")) {
			const { value, done } = await reader.read();
			if (done) break;
			seen += text.decode(value);
		}
		await reader.cancel();
		assert.ok(!seen.includes("chats-changed"), "B's event stays in B");
		assert.ok(seen.includes("turn-started"));
		assert.ok(seen.includes("subscriptions-changed"), "user-level events reach every project window");
		assert.ok(seen.includes("activity-changed"), "process-wide events reach everyone");
	});

	it("sameAudience: other users never hear each other", () => {
		const a: DataScope = { userId: "a", admin: false, userRoot: "/a", project: { id: "p", root: "/a/p" } };
		const b: DataScope = { userId: "b", admin: false, userRoot: "/b", project: { id: "p", root: "/b/p" } };
		assert.equal(sameAudience(a, b), false);
		assert.equal(sameAudience(a, { ...a, project: undefined }), true);
		assert.equal(sameAudience(a, undefined), true);
	});
});

describe("project lifecycle on the server", () => {
	it("old chat links find their project; delete refuses while work runs", () => {
		const root = PATHS.data;
		const project = createProject(root, "Lifecycle");
		try {
			const scope: DataScope = { ...scopeFor(localUser()) };
			const chat = runInDataScope({ ...scope, project: { id: project.id, root: projectRootFor(root, project.id) } }, () => chatStore.createChat("x"));
			assert.equal(runInDataScope(scope, () => projectOfChat(chat.id)), project.id);
			const job = runInDataScope({ ...scope, project: { id: project.id, root: projectRootFor(root, project.id) } }, () =>
				jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "t1" }),
			);
			const refused = runInDataScope(scope, () => deleteUserProject(project.id));
			assert.equal(refused.ok, false);
			assert.equal(!refused.ok && refused.status, 409);
			runInDataScope({ ...scope, project: { id: project.id, root: projectRootFor(root, project.id) } }, () =>
				jobStore.updateJob(job.id, { status: "done" }),
			);
			assert.equal(runInDataScope(scope, () => deleteUserProject(project.id)).ok, true);
			assert.equal(getProject(root, project.id), null);
		} finally {
			deleteProject(root, project.id);
		}
	});
});

describe("client project routing", () => {
	it("paths, hrefs and the EventSource/download query", () => {
		assert.equal(projectIdFromPath("/p/prj_1/chat/c1"), "prj_1");
		assert.equal(projectIdFromPath("/p/prj_1"), "prj_1");
		assert.equal(projectIdFromPath("/"), null);
		assert.equal(projectIdFromPath("/chat/c1"), null);
		assert.equal(projectHref("prj_1", "/chat/new"), "/p/prj_1/chat/new");
		assert.equal(apiUrlWithProject("/api/events", "prj_1"), "/api/events?project=prj_1");
		assert.equal(apiUrlWithProject("/api/x?a=1", "prj_1"), "/api/x?a=1&project=prj_1");
		assert.equal(apiUrlWithProject("/api/events", null), "/api/events");
	});

	it("each project keeps its own graph camera", () => {
		assert.equal(cameraStorageKey("prj_1"), "lh.graph.camera.v1:prj_1");
		assert.equal(cameraStorageKey(null), "lh.graph.camera.v1");
	});

	it("the list shows active or archived rows, newest activity first", () => {
		const row = (id: string, activityAt: string, archivedAt?: string) => ({ id, name: id, createdAt: "", chatCount: 0, activityAt, ...(archivedAt ? { archivedAt } : {}) });
		const rows = [row("old", "2026-01-01"), row("new", "2026-10-01"), row("gone", "2026-09-01", "2026-09-02")];
		assert.deepEqual(visibleProjects(rows, false).map((r) => r.id), ["new", "old"]);
		assert.deepEqual(visibleProjects(rows, true).map((r) => r.id), ["gone"]);
	});
});
