import { handleChatRequest, scoped } from "@/src/server";

async function POSTHandler(req: Request) {
	return handleChatRequest(req);
}

export const POST = scoped(POSTHandler, { project: "required" });
