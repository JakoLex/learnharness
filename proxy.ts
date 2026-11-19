import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal } from "./src/server/desktop-access.ts";

/** The session cookie's name (src/store/accounts.ts SESSION_COOKIE) — kept
 *  literal here so the proxy loads no store code. */
const SESSION_COOKIE = "lh_session";

/** Pages and routes a signed-out browser may reach in accounts mode. */
function openWithoutSession(pathname: string): boolean {
	return pathname === "/login" || pathname === "/setup" || pathname.startsWith("/api/auth/");
}

/**
 * Two gates, in order:
 * 1. API request policy (every /api method, including SSE and spending/
 *    settings routes): the desktop capability, or in browser-only mode the
 *    Host and cross-site write checks (src/server/desktop-access.ts). The
 *    one streamed document route enforces the identical all-method request
 *    policy inside its handler, avoiding Next's silently truncated Proxy
 *    body clone. No public callback or worker bypass: legitimate self-HTTP
 *    still needs the capability.
 * 2. Accounts mode (LH_ACCOUNTS=1, accounts wave 2026-10-28): the
 *    OPTIMISTIC sign-in check the Next auth guide recommends — only the
 *    cookie's presence; every route and page verifies the session itself
 *    (src/server/scope.ts). Pages redirect to /login, APIs answer 401.
 */
export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	const api = pathname === "/api" || pathname.startsWith("/api/");
	const refusal = api ? apiRequestRefusal(request) : undefined;
	if (refusal) {
		return NextResponse.json(
			{ error: refusal },
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

export const config = {
	// API: keep /api itself covered; exempt only the exact streamed endpoint,
	// not the documents subtree or other plugin routes. Pages (accounts
	// gate): every other route except Next's static assets and files with an
	// extension (fonts, icons, images from public/). Must remain static literals.
	matcher: [
		"/api",
		"/api/((?!plugins/[^/]+/documents/markdown/?$).*)",
		"/((?!api(?:/|$)|_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)",
	],
};
