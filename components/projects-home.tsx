"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArchiveIcon, ArchiveRestoreIcon, PencilIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { LhMark } from "@/components/lh-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { timeAgo } from "@/components/sidebar";
import { projectHref } from "@/components/project-paths";

/**
 * THE PROJECT LIST (projects wave, owner-approved 2026-10-28) — the start
 * page, OpenScience-style: every project of the user with its session
 * count and last activity (newest first), a "New project" form, and per
 * row rename / archive / delete; archived projects sit behind a toggle
 * with restore. Opening a project goes to its graph home (/p/<id>).
 */

export interface ProjectListItem {
	id: string;
	name: string;
	createdAt: string;
	archivedAt?: string;
	chatCount: number;
	activityAt: string;
}

/** Active or archived rows, newest activity first (pure — tests). */
export function visibleProjects(projects: readonly ProjectListItem[], archived: boolean): ProjectListItem[] {
	return projects
		.filter((p) => Boolean(p.archivedAt) === archived)
		.sort((a, b) => b.activityAt.localeCompare(a.activityAt));
}

async function readError(res: Response): Promise<string> {
	const body = (await res.json().catch(() => null)) as { error?: string } | null;
	return body?.error ?? `Request failed (${res.status})`;
}

export function ProjectsHome({ initialProjects }: { initialProjects: ProjectListItem[] }) {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const [projects, setProjects] = useState(initialProjects);
	const [showArchived, setShowArchived] = useState(false);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const shown = useMemo(() => visibleProjects(projects, showArchived), [projects, showArchived]);
	const archivedCount = useMemo(() => projects.filter((p) => p.archivedAt).length, [projects]);

	const refresh = useCallback(async () => {
		const res = await fetch("/api/projects", { cache: "no-store" }).catch(() => null);
		if (res?.ok) setProjects(((await res.json()) as { projects: ProjectListItem[] }).projects);
	}, []);

	const create = useCallback(async () => {
		const name = newName.trim();
		if (!name || busy) return;
		setBusy(true);
		setError(null);
		const res = await fetch("/api/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		}).catch(() => null);
		if (!res?.ok) {
			setBusy(false);
			setError(res ? await readError(res) : "Could not create the project. Check the connection.");
			return;
		}
		const { project } = (await res.json()) as { project: { id: string } };
		router.push(projectHref(project.id));
	}, [newName, busy, router]);

	const patch = useCallback(
		async (id: string, body: { name?: string; archived?: boolean }) => {
			setError(null);
			const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}).catch(() => null);
			if (!res?.ok) {
				setError(res ? await readError(res) : "Could not save. Check the connection.");
				return false;
			}
			await refresh();
			return true;
		},
		[refresh],
	);

	const remove = useCallback(
		async (id: string) => {
			setError(null);
			const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
			setConfirmDelete(null);
			if (!res?.ok) {
				setError(res ? await readError(res) : "Could not delete. Check the connection.");
				return;
			}
			await refresh();
		},
		[refresh],
	);

	return (
		<main className="min-w-0 flex-1 overflow-y-auto" data-testid="projects-home">
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
				<header className="flex items-center gap-3">
					<LhMark className="size-7" />
					<h1 className="flex-1 font-ui text-lg">Projects</h1>
					<Button variant="ghost" size="icon" aria-label="Settings" title="Settings" onClick={() => openSettings()}>
						<SettingsIcon className="size-4" />
					</Button>
				</header>

				{creating ? (
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							void create();
						}}
					>
						<Input
							autoFocus
							data-testid="new-project-name"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									setCreating(false);
									setNewName("");
								}
							}}
							placeholder="Project name"
							aria-label="Project name"
							maxLength={120}
						/>
						<Button type="submit" disabled={!newName.trim() || busy} data-testid="create-project">
							Create
						</Button>
						<Button type="button" variant="ghost" onClick={() => { setCreating(false); setNewName(""); }}>
							Cancel
						</Button>
					</form>
				) : (
					<Button variant="outline" className="self-start" data-testid="new-project" onClick={() => setCreating(true)}>
						<PlusIcon className="size-4" />
						New project
					</Button>
				)}

				{error && (
					<p role="alert" className="text-sm text-red-400">
						{error}
					</p>
				)}

				<ul className="flex flex-col gap-1" data-testid="project-list">
					{shown.length === 0 && (
						<li className="py-6 text-center text-sm text-muted-foreground">
							{showArchived ? "No archived projects." : "No projects yet — create one to start learning."}
						</li>
					)}
					{shown.map((project) => (
						<li
							key={project.id}
							data-testid="project-row"
							className="group flex items-center gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-accent"
						>
							{renaming?.id === project.id ? (
								<form
									className="flex flex-1 items-center gap-2"
									onSubmit={async (e) => {
										e.preventDefault();
										const name = renaming.name.trim();
										if (!name) return;
										if (await patch(project.id, { name })) setRenaming(null);
									}}
								>
									<Input
										autoFocus
										value={renaming.name}
										onChange={(e) => setRenaming({ id: project.id, name: e.target.value })}
										onKeyDown={(e) => {
											if (e.key === "Escape") setRenaming(null);
										}}
										aria-label="New project name"
										maxLength={120}
									/>
									<Button type="submit" size="sm" disabled={!renaming.name.trim()}>
										Save
									</Button>
								</form>
							) : (
								<Link href={projectHref(project.id)} className="min-w-0 flex-1">
									<span className="block truncate font-medium text-foreground">{project.name}</span>
									<span className="block text-xs text-muted-foreground">
										{project.chatCount === 1 ? "1 session" : `${project.chatCount} sessions`} · {timeAgo(project.activityAt)}
									</span>
								</Link>
							)}
							{confirmDelete === project.id ? (
								<span className="flex shrink-0 items-center gap-2 text-xs">
									<span className="text-muted-foreground">Delete with all sessions and its graph?</span>
									<Button size="sm" variant="destructive" data-testid="confirm-delete-project" onClick={() => void remove(project.id)}>
										Delete
									</Button>
									<Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
										Cancel
									</Button>
								</span>
							) : (
								renaming?.id !== project.id && (
									<span className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
										<Button
											variant="ghost"
											size="icon"
											aria-label={`Rename ${project.name}`}
											title="Rename"
											onClick={() => setRenaming({ id: project.id, name: project.name })}
										>
											<PencilIcon className="size-3.5" />
										</Button>
										<Button
											variant="ghost"
											size="icon"
											aria-label={project.archivedAt ? `Restore ${project.name}` : `Archive ${project.name}`}
											title={project.archivedAt ? "Restore" : "Archive"}
											onClick={() => void patch(project.id, { archived: !project.archivedAt })}
										>
											{project.archivedAt ? <ArchiveRestoreIcon className="size-3.5" /> : <ArchiveIcon className="size-3.5" />}
										</Button>
										<Button
											variant="ghost"
											size="icon"
											aria-label={`Delete ${project.name}`}
											title="Delete"
											onClick={() => setConfirmDelete(project.id)}
										>
											<Trash2Icon className="size-3.5" />
										</Button>
									</span>
								)
							)}
						</li>
					))}
				</ul>

				{(archivedCount > 0 || showArchived) && (
					<button
						type="button"
						data-testid="toggle-archived"
						onClick={() => setShowArchived((v) => !v)}
						className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
					>
						{showArchived ? "← Back to projects" : `Archived (${archivedCount})`}
					</button>
				)}
			</div>
		</main>
	);
}
