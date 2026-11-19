import { createPluginDocumentRoute, pluginTransport, scoped } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fork (accounts): this route skips the Proxy, so scoped() is its sign-in
// gate. It runs inside the route's POST, AFTER the identical request policy
// (403 before 401, as in the Proxy), and reads only the cookie and the
// project header — never the body.
const convertSignedIn = scoped(
	(request: Request, id: string) => pluginTransport.convertDocument(id, request),
	{ project: "optional" },
);

// This exact route skips Proxy body cloning, NOT desktop authentication.
const handlers = createPluginDocumentRoute({ convertDocument: (id, request) => convertSignedIn(request, id) });
export const POST = handlers.POST;
export const OPTIONS = handlers.OPTIONS;
export const GET = handlers.GET;
export const HEAD = handlers.HEAD;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
