import { notFound } from "next/navigation";
import { Home } from "@/components/home";
import { readSettingsRecord, withPageScope } from "@/src/server";
import { resolveSettings, slotsConfigured } from "@/src/core";

// Dynamic: the configured state is server-rendered into the page (the
// setup CTA's truth on the first frame), and every navigation re-reads
// the record (dynamic routes aren't cached client-side).
export const dynamic = "force-dynamic";

/** A project's home: its graph (projects wave — the list lives at /). */
export default async function ProjectHomePage({ params }: { params: Promise<{ project: string }> }) {
	const { project } = await params;
	const scoped = await withPageScope(project, () => readSettingsRecord());
	if (!scoped) notFound();
	// First-run gate (model-slots wave): chats cannot start until the user
	// has picked all three slots — the dock shows the CTA while the raw
	// record's models section lacks any slot pin.
	const record = scoped.value;
	// GRAPH RENDERING (owner, 2026-10-06): off = the home's main view is
	// the chains view. Resolved through the one core resolver (missing
	// section / absent key → factory default on); re-read per navigation.
	const rendering = resolveSettings(record ?? null).graph.rendering;
	return (
		<Home initialConfigured={slotsConfigured(record?.models)} rendering={rendering} />
	);
}
