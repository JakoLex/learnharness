import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { slotsConfigured } from "@/src/core";
import { compactionInFlight, getChat, isTurnRunning, readSettingsRecord, turnFailure, withPageScope } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ project: string; id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ project, id }, { prompt }] = await Promise.all([params, searchParams]);
	// Every read runs in the project's scope (projects wave).
	const scoped = await withPageScope(project, () => {
		const chat = getChat(id);
		if (!chat) return null;
		return {
			chat,
			// The persistent setup CTA's seed (BYOK, owner 2026-09-22): slotsConfigured
			// over the settings record, server-read — the same gate home/new read. The
			// server's 503 stays the truth; this only decides whether the pill rides.
			record: readSettingsRecord(),
			failure: turnFailure(id),
			inFlight: isTurnRunning(id),
			compacting: compactionInFlight(id),
		};
	});
	if (!scoped?.value) notFound();
	const { chat, record, failure, inFlight, compacting } = scoped.value;
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			// Wave D: the record IS native agent history — the client view is
				// derived app-side (core/view.ts projectView; GET serves the same
				// native messages).
				initialMessages={chat.messages}
			initialError={failure}
			initialConfigured={slotsConfigured(record?.models)}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={inFlight}
			initiallyCompacting={compacting}
		/>
	);
}
