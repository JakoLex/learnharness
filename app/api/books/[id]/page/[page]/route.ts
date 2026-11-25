/**
 * GET /api/books/[id]/page/[page] — one PDF page as PNG for the page viewer
 * (fork, owner 2026-11-24). Rendered on the server with pdf.js and cached
 * with the book. An <img> cannot send headers, so the project rides as
 * ?project=.
 */
import { BookError, bookPageImage, scoped } from "@/src/server";

export const dynamic = "force-dynamic";

async function GETHandler(_request: Request, { params }: { params: Promise<{ id: string; page: string }> }) {
	const { id, page } = await params;
	try {
		const png = await bookPageImage(id, Number(page));
		return new Response(new Uint8Array(png), {
			headers: { "content-type": "image/png", "cache-control": "private, max-age=86400" },
		});
	} catch (err) {
		if (err instanceof BookError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

export const GET = scoped(GETHandler, { project: "required" });
