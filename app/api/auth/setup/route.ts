/** POST /api/auth/setup {name, password} — the first account (the admin)
 *  while none exists; it takes over the server's existing data. */
import { authResponse, sessionCookie, setupAdmin } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = ((await request.json().catch(() => null)) ?? {}) as { name?: unknown; password?: unknown };
	const result = setupAdmin(body);
	if (!result.ok) return authResponse(result);
	return authResponse({ ok: true, user: result.user }, sessionCookie(result.token));
}
