import { pluginTransport, scoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fork (projects/accounts): operations may read the learner's chats and
// graph, so they run in the window's project when it names one.
export const POST = scoped(async (request: Request, context: { params: Promise<{ id: string }> }) => {
	return pluginTransport.call((await context.params).id, request);
}, { project: "optional" });
