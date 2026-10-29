import { claudeCodeInstallationResponse, scoped } from "@/src/server";

/** Installation/version only; never reads auth status or makes a model request.
 *  Admin-only here; off in this fork unless LH_CLAUDE_CODE=1 (fork-features.ts). */
async function GETHandler(request: Request) {
	return claudeCodeInstallationResponse(request);
}

export const GET = scoped(GETHandler, { project: "none", admin: true });
