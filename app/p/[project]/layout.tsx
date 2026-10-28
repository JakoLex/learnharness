import { notFound } from "next/navigation";
import { ProjectShell } from "@/components/sidebar";
import { withPageScope } from "@/src/server";

export const dynamic = "force-dynamic";

/** One project's frame (projects wave, owner-approved 2026-10-28): the
 *  sessions sidebar with the project's name, beside its pages. */
export default async function ProjectLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ project: string }>;
}) {
	const { project } = await params;
	const scoped = await withPageScope(project, (record) => record);
	if (!scoped?.value) notFound();
	const { id, name } = scoped.value;
	return <ProjectShell project={{ id, name }}>{children}</ProjectShell>;
}
