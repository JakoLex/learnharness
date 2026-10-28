/** PUT /api/accounts/[id]/password {password} — reset someone's password;
 *  their sessions end. Admin only. */
import { authResponse, resetPasswordAsAdmin, scoped } from "@/src/server";

export const dynamic = "force-dynamic";

async function PUTHandler(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = ((await request.json().catch(() => null)) ?? {}) as { password?: unknown };
	return authResponse(resetPasswordAsAdmin(id, body));
}

export const PUT = scoped(PUTHandler, { project: "none", admin: true });
