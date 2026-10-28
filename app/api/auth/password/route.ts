/** PUT /api/auth/password {current, next} — change your own password;
 *  your other sessions end. */
import { authResponse, changeOwnPassword, scoped } from "@/src/server";

export const dynamic = "force-dynamic";

async function PUTHandler(request: Request) {
	const body = ((await request.json().catch(() => null)) ?? {}) as { current?: unknown; next?: unknown };
	return authResponse(changeOwnPassword(request, body));
}

export const PUT = scoped(PUTHandler, { project: "none" });
