import { pluginTransport, scoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fork (accounts): signed-in users only; assets are server-wide files.
export const GET = scoped(async (_request: Request, context: { params: Promise<{ id: string; file: string[] }> }) => {
	const { id, file } = await context.params;
	return pluginTransport.asset(id, file);
}, { project: "none" });
