/** POST /api/auth/logout — end this session and clear its cookie. */
import { authResponse, clearedSessionCookie, signOut } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	signOut(request);
	return authResponse({ ok: true }, clearedSessionCookie());
}
