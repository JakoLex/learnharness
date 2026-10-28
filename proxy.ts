import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";

/** The session cookie's name (src/store/accounts.ts SESSION_COOKIE) — kept
 *  literal here so the proxy loads no store code. */
const SESSION_COOKIE = "lh_session";

/** Pages and routes a signed-out browser may reach in accounts mode. */
function openWithoutSession(pathname: string): boolean {
	return pathname === "/login" || pathname === "/setup" || pathname.startsWith("/api/auth/");
}

/**
 * Two gates, in order:
 * 1. Desktop API access (every /api method, including SSE and spending/
 *    settings routes): no public callback or worker bypass — internal jobs
 *    call server functions, and any legitimate self-HTTP request must carry
 *    the private capability.
 * 2. Accounts mode (LH_ACCOUNTS=1, accounts wave 2026-10-28): the
 *    OPTIMISTIC sign-in check the Next auth guide recommends — only the
 *    cookie's presence; every route and page verifies the session itself
 *    (src/server/scope.ts). Pages redirect to /login, APIs answer 401.
 */
export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	const api = pathname === "/api" || pathname.startsWith("/api/");
	if (api && !desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	if (process.env.LH_ACCOUNTS === "1" && !openWithoutSession(pathname) && !request.cookies.get(SESSION_COOKIE)?.value) {
		if (api) {
			return NextResponse.json(
				{ error: "Please sign in.", code: "auth_required" },
				{ status: 401, headers: { "Cache-Control": "no-store" } },
			);
		}
		return NextResponse.redirect(new URL("/login", request.url));
	}
	return NextResponse.next();
}

// Every route except Next's static assets and files with an extension
// (fonts, icons, images from public/).
export const config = { matcher: ["/((?!_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)"] };
