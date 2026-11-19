import { pluginTransport, scoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fork (accounts): enabling and disabling a plugin is the admin's.
export const PUT = scoped(async (request: Request, context: { params: Promise<{ id: string }> }) => {
	return pluginTransport.setEnabled((await context.params).id, request);
}, { project: "none", admin: true });
