import { subscriptionControlsResponse, scoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = scoped(subscriptionControlsResponse, { project: "none", admin: true });
export const POST = scoped(subscriptionControlsResponse, { project: "none", admin: true });
