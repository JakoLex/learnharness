"use client";

import { useState } from "react";
import { LhMark } from "@/components/lh-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * SIGN-IN / FIRST SETUP (accounts wave, owner-approved 2026-10-28). Setup
 * creates the admin — the first account, which takes over the server's
 * existing projects and settings. On success the page reloads into the
 * app, so every provider starts over signed in.
 */
export function AuthForm({ mode }: { mode: "login" | "setup" }) {
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const setup = mode === "setup";
	const mismatch = setup && confirm.length > 0 && confirm !== password;

	const submit = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		const res = await fetch(setup ? "/api/auth/setup" : "/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, password }),
		}).catch(() => null);
		if (!res?.ok) {
			const body = (await res?.json().catch(() => null)) as { error?: string } | null;
			setError(body?.error ?? "No connection to the server.");
			setBusy(false);
			return;
		}
		window.location.assign("/");
	};

	return (
		<main className="flex min-w-0 flex-1 items-center justify-center px-4" data-testid={setup ? "setup-page" : "login-page"}>
			<form
				className="flex w-full max-w-xs flex-col gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<div className="mb-2 flex items-center gap-3">
					<LhMark className="size-7" />
					<h1 className="font-ui text-lg">{setup ? "Set up LearnHarness" : "Sign in"}</h1>
				</div>
				{setup && (
					<p className="text-sm text-muted-foreground">
						Create the admin account. It keeps everything already on this server and manages keys and the other accounts.
					</p>
				)}
				<Input autoFocus autoComplete="username" placeholder="Name" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
				<Input
					type="password"
					autoComplete={setup ? "new-password" : "current-password"}
					placeholder={setup ? "Password (8+ characters)" : "Password"}
					aria-label="Password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
				/>
				{setup && (
					<Input type="password" autoComplete="new-password" placeholder="Repeat password" aria-label="Repeat password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
				)}
				{(error || mismatch) && (
					<p role="alert" className="text-sm text-red-400">
						{mismatch ? "The passwords differ." : error}
					</p>
				)}
				<Button type="submit" disabled={busy || !name.trim() || !password || (setup && (password.length < 8 || confirm !== password))} data-testid="auth-submit">
					{setup ? "Create admin account" : "Sign in"}
				</Button>
			</form>
		</main>
	);
}
