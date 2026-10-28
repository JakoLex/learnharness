/** GET /api/accounts — every account; POST {name, password} — create one
 *  (starts with a copy of the admin's models). Admin only. */
import { accountsForAdmin, authResponse, createAccountAsAdmin, scoped } from "@/src/server";

export const dynamic = "force-dynamic";

async function GETHandler() {
	return authResponse(accountsForAdmin());
}

async function POSTHandler(request: Request) {
	const body = ((await request.json().catch(() => null)) ?? {}) as { name?: unknown; password?: unknown };
	return authResponse(createAccountAsAdmin(body));
}

export const GET = scoped(GETHandler, { project: "none", admin: true });
export const POST = scoped(POSTHandler, { project: "none", admin: true });
