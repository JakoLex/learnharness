"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsGroup, SettingsRow } from "./controls.tsx";

/**
 * ACCOUNT SETTINGS (accounts wave, owner-approved 2026-10-28). With
 * accounts on, everyone gets "Account" (change your password, sign out)
 * and the admin also gets "Accounts" (create an account with a starting
 * password, reset someone's password, delete an account with its data —
 * never your own). Without accounts neither section exists.
 */

export interface Viewer {
	accounts: boolean;
	user: { id: string; name: string; admin: boolean } | null;
}

/** Which account sections the viewer gets (pure — tests). */
export function accountSectionIds(viewer: Viewer | null): ("account" | "accounts")[] {
	if (!viewer?.accounts || !viewer.user) return [];
	return viewer.user.admin ? ["account", "accounts"] : ["account"];
}

async function errorOf(res: Response | null): Promise<string> {
	if (!res) return "No connection to the server.";
	const body = (await res.json().catch(() => null)) as { error?: string } | null;
	return body?.error ?? `Request failed (${res.status})`;
}

export function AccountSection({ viewer }: { viewer: Viewer }) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

	const change = async () => {
		setStatus(null);
		const res = await fetch("/api/auth/password", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ current, next }),
		}).catch(() => null);
		if (!res?.ok) {
			setStatus({ ok: false, text: await errorOf(res) });
			return;
		}
		setCurrent("");
		setNext("");
		setStatus({ ok: true, text: "Password changed. Other devices were signed out." });
	};

	const signOut = async () => {
		await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
		window.location.assign("/login");
	};

	return (
		<>
			<SettingsGroup label="Signed in" testid="group-signed-in">
				<SettingsRow label={viewer.user?.name ?? ""} hint={viewer.user?.admin ? "Admin" : undefined} testid="account-name">
					<Button variant="outline" size="sm" data-testid="sign-out" onClick={() => void signOut()}>
						Sign out
					</Button>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label="Password" testid="group-password">
				<form
					className="flex flex-col gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void change();
					}}
				>
					<Input type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
					<Input type="password" autoComplete="new-password" placeholder="New password (8+ characters)" aria-label="New password" value={next} onChange={(e) => setNext(e.target.value)} />
					<Button type="submit" size="sm" className="self-start" disabled={!current || next.length < 8} data-testid="change-password">
						Change password
					</Button>
					{status && (
						<p role={status.ok ? "status" : "alert"} className={status.ok ? "text-xs text-muted-foreground" : "text-xs text-red-400"}>
							{status.text}
						</p>
					)}
				</form>
			</SettingsGroup>
		</>
	);
}

interface AccountRow {
	id: string;
	name: string;
	admin: boolean;
}

export function AccountsSection({ viewer }: { viewer: Viewer }) {
	const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [resetting, setResetting] = useState<{ id: string; password: string } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

	const load = useCallback(async () => {
		const res = await fetch("/api/accounts", { cache: "no-store" }).catch(() => null);
		if (res?.ok) setAccounts(((await res.json()) as { accounts: AccountRow[] }).accounts);
		else setStatus({ ok: false, text: await errorOf(res) });
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const send = async (url: string, method: string, body: unknown, done: string) => {
		setStatus(null);
		const res = await fetch(url, {
			method,
			headers: { "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}).catch(() => null);
		if (!res?.ok) {
			setStatus({ ok: false, text: await errorOf(res) });
			return false;
		}
		setStatus({ ok: true, text: done });
		await load();
		return true;
	};

	return (
		<>
			<SettingsGroup label="Accounts" testid="group-accounts">
				{accounts === null ? (
					<p className="text-xs text-muted-foreground/70">Loading accounts…</p>
				) : (
					accounts.map((account) => (
						<SettingsRow key={account.id} label={account.name} hint={account.admin ? "Admin" : undefined} testid={`account-row-${account.name}`}>
							{resetting?.id === account.id ? (
								<form
									className="flex items-center gap-2"
									onSubmit={async (e) => {
										e.preventDefault();
										if (await send(`/api/accounts/${account.id}/password`, "PUT", { password: resetting.password }, `New password set for ${account.name}.`)) setResetting(null);
									}}
								>
									<Input type="password" autoComplete="new-password" placeholder="New password" aria-label={`New password for ${account.name}`} value={resetting.password} onChange={(e) => setResetting({ id: account.id, password: e.target.value })} className="h-8 w-44" />
									<Button type="submit" size="sm" disabled={resetting.password.length < 8}>
										Set
									</Button>
									<Button type="button" size="sm" variant="ghost" onClick={() => setResetting(null)}>
										Cancel
									</Button>
								</form>
							) : confirmDelete === account.id ? (
								<span className="flex items-center gap-2 text-xs">
									<span className="text-muted-foreground">Delete with all projects?</span>
									<Button
										size="sm"
										variant="destructive"
										onClick={async () => {
											setConfirmDelete(null);
											await send(`/api/accounts/${account.id}`, "DELETE", undefined, `${account.name} was deleted.`);
										}}
									>
										Delete
									</Button>
									<Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
										Cancel
									</Button>
								</span>
							) : (
								<span className="flex items-center gap-1">
									<Button size="sm" variant="ghost" onClick={() => setResetting({ id: account.id, password: "" })}>
										Reset password
									</Button>
									{account.id !== viewer.user?.id && (
										<Button size="sm" variant="ghost" onClick={() => setConfirmDelete(account.id)}>
											Delete
										</Button>
									)}
								</span>
							)}
						</SettingsRow>
					))
				)}
			</SettingsGroup>
			<SettingsGroup label="New account" testid="group-new-account">
				<form
					className="flex flex-col gap-2"
					onSubmit={async (e) => {
						e.preventDefault();
						if (await send("/api/accounts", "POST", { name, password }, `Account ${name.trim().toLowerCase()} created — it starts with your models.`)) {
							setName("");
							setPassword("");
						}
					}}
				>
					<Input placeholder="Name (lowercase, 2–32 characters)" aria-label="Account name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
					<Input type="password" autoComplete="new-password" placeholder="Starting password (8+ characters)" aria-label="Starting password" value={password} onChange={(e) => setPassword(e.target.value)} />
					<Button type="submit" size="sm" className="self-start" disabled={!name.trim() || password.length < 8} data-testid="create-account">
						Create account
					</Button>
				</form>
				{status && (
					<p role={status.ok ? "status" : "alert"} className={status.ok ? "text-xs text-muted-foreground" : "text-xs text-red-400"}>
						{status.text}
					</p>
				)}
			</SettingsGroup>
		</>
	);
}
