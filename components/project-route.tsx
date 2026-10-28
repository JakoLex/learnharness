"use client";

import { createContext, useCallback, useContext } from "react";
import { usePathname } from "next/navigation";

/**
 * PROJECT ROUTING (projects wave, owner-approved 2026-10-28): a project's
 * pages live under /p/<projectId>/ — its graph home at /p/<id>, chats at
 * /p/<id>/chat/<chatId>. The project list is /. The URL is the truth for
 * which project a window shows; every API call derives its project from
 * it (api-fetch.ts), so nothing else needs to carry the id.
 */

export { projectHref, projectIdFromPath } from "./project-paths.ts";
import { projectHref, projectIdFromPath } from "./project-paths.ts";

/** The project of the current route (null on the project list). */
export function useProjectId(): string | null {
	return projectIdFromPath(usePathname());
}

/** Prefix an in-project path with the current project — the list (/)
 *  when the route has none. */
export function useProjectPath(): (path?: string) => string {
	const projectId = useProjectId();
	return useCallback((path = "") => (projectId ? projectHref(projectId, path) : "/"), [projectId]);
}

/** The open project's record, provided by its layout (app/p/[project]). */
export interface ProjectInfo {
	id: string;
	name: string;
}

const ProjectContext = createContext<ProjectInfo | null>(null);

export function ProjectProvider({ project, children }: { project: ProjectInfo; children: React.ReactNode }) {
	return <ProjectContext.Provider value={project}>{children}</ProjectContext.Provider>;
}

/** The open project (null outside a project layout). */
export function useProject(): ProjectInfo | null {
	return useContext(ProjectContext);
}
