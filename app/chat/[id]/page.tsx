import { notFound, redirect } from "next/navigation";
import { projectOfChat, withPageScope } from "@/src/server";

export const dynamic = "force-dynamic";

/** Pre-projects links (/chat/<id>) land on the chat inside its project. */
export default async function LegacyChatPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const found = await withPageScope(null, () => projectOfChat(id));
	if (!found?.value) notFound();
	redirect(`/p/${encodeURIComponent(found.value)}/chat/${encodeURIComponent(id)}`);
}
