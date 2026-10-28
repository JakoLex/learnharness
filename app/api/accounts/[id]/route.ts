/** DELETE /api/accounts/[id] — delete an account with all its data (never
 *  your own). Admin only. */
import { authResponse, deleteAccountAsAdmin, scoped } from "@/src/server";

export const dynamic = "force-dynamic";

async function DELETEHandler(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return authResponse(deleteAccountAsAdmin(id));
}

export const DELETE = scoped(DELETEHandler, { project: "none", admin: true });
