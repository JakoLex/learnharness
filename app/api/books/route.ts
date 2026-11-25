/**
 * GET /api/books — the project's bookshelf (fork, owner 2026-11-24).
 * POST /api/books — add one PDF (multipart field "file"); indexing runs in
 * the background, the list shows its progress. The same PDF twice is
 * recognized and not stored again.
 */
import { addBook, BookError, listBooks, MAX_BOOK_BYTES, scoped } from "@/src/server";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data.ts";

export const dynamic = "force-dynamic";

async function GETHandler() {
	return Response.json({ books: listBooks() });
}

async function POSTHandler(request: Request) {
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_BOOK_BYTES + 1024 * 1024);
	} catch (err) {
		const oversized = err instanceof FormBodyLimitError;
		return Response.json(
			{ error: oversized ? `Too big. Max ${MAX_BOOK_BYTES / (1024 * 1024)} MB.` : "Could not read the upload. Please try again." },
			{ status: oversized ? 413 : 400 },
		);
	}
	const file = form.get("file");
	if (!(file instanceof File)) return Response.json({ error: "No file." }, { status: 400 });
	try {
		const { book, duplicate } = addBook({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
		return Response.json({ book, duplicate });
	} catch (err) {
		if (err instanceof BookError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

export const GET = scoped(GETHandler, { project: "required" });
export const POST = scoped(POSTHandler, { project: "required" });
