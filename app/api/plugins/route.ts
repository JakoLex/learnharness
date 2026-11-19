import { pluginTransport, scoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fork (accounts): everyone signed in reads the catalog; refreshing it
// (picking up installed or removed packages) is the admin's.
export const GET = scoped(() => pluginTransport.list(), { project: "none" });
export const POST = scoped((request: Request) => pluginTransport.refresh(request), { project: "none", admin: true });
