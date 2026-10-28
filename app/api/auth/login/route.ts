/** POST /api/auth/login {name, password} — sign in; sets the session
 *  cookie (accounts wave, owner-approved 2026-10-28). */
import { authResponse, sessionCookie, signIn } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = ((await request.json().catch(() => null)) ?? {}) as { name?: unknown; password?: unknown };
	const result = await signIn(body);
	if (!result.ok) return authResponse(result);
	return authResponse({ ok: true, user: result.user }, sessionCookie(result.token));
}
