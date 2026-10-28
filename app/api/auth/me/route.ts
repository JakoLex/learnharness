/** GET /api/auth/me — who is viewing: {accounts, setupNeeded, user}. */
import { scoped, whoAmI } from "@/src/server";

export const dynamic = "force-dynamic";

async function GETHandler(request: Request) {
	return Response.json(whoAmI(request), { headers: { "Cache-Control": "no-store" } });
}

export const GET = scoped(GETHandler, { project: "none" });
