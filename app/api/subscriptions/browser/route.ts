import { subscriptionBrowserResponse, scoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = scoped(subscriptionBrowserResponse, { project: "none", admin: true });
export const POST = scoped(subscriptionBrowserResponse, { project: "none", admin: true });
