import { ProjectsHome } from "@/components/projects-home";
import { projectsOfUser, withPageScope } from "@/src/server";

// Dynamic: the list is the user's current truth on every visit.
export const dynamic = "force-dynamic";

/** The start page (projects wave, owner-approved 2026-10-28): the user's
 *  projects, OpenScience-style — open one, create, rename, archive,
 *  restore, delete. */
export default async function ProjectsPage() {
	const scoped = await withPageScope(null, () => projectsOfUser());
	return <ProjectsHome initialProjects={scoped?.value ?? []} />;
}
