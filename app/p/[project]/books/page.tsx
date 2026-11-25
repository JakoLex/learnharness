import { notFound } from "next/navigation";
import { BooksShelf } from "@/components/books-shelf";
import { withPageScope } from "@/src/server";

export const dynamic = "force-dynamic";

/** A project's bookshelf (fork, owner 2026-11-24). */
export default async function ProjectBooksPage({ params }: { params: Promise<{ project: string }> }) {
	const { project } = await params;
	const scoped = await withPageScope(project, (record) => record);
	if (!scoped?.value) notFound();
	return <BooksShelf />;
}
