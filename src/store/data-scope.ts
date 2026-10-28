import { AsyncLocalStorage } from "node:async_hooks";

/**
 * THE DATA SCOPE (projects wave, owner-approved 2026-10-28): which user and
 * which project the running code reads and writes. Every mutable path in
 * config.ts resolves through it, so one server process can hold several
 * users, each with several projects, without any store knowing about them.
 *
 * Entered once per request (src/server/scope.ts `scoped` for routes,
 * `withPageScope` for pages) and inherited by everything the request
 * starts — AsyncLocalStorage follows promises and timers, so background
 * extraction, jobs, wake turns and compaction stay in their project.
 *
 * On globalThis like the other process registries, so dev-mode module
 * re-evaluation never splits the store a running turn reads from.
 */
export interface DataScope {
	/** The account; "local" when accounts are off. */
	userId: string;
	/** Admins manage keys and accounts and keep the file tools. */
	admin: boolean;
	/** Per-user root: settings.json, prompts/, projects/. */
	userRoot: string;
	/** The selected project, when the work is project-bound. */
	project?: { id: string; root: string };
}

const SCOPE_KEY = Symbol.for("lh.dataScope");
const scopeGlobal = globalThis as typeof globalThis & { [SCOPE_KEY]?: AsyncLocalStorage<DataScope> };
const storage = (scopeGlobal[SCOPE_KEY] ??= new AsyncLocalStorage<DataScope>());

/** Run `fn` (and everything it starts) inside `scope`. */
export function runInDataScope<T>(scope: DataScope, fn: () => T): T {
	return storage.run(scope, fn);
}

/** The scope the running code was started in, if any. */
export function activeDataScope(): DataScope | undefined {
	return storage.getStore();
}

/** Run `fn` (and everything it starts) OUTSIDE any scope — process-wide
 *  work such as a provider outage that every user's windows must hear. */
export function runUnscoped<T>(fn: () => T): T {
	return storage.exit(fn);
}

/** Whether an event emitted in `source` reaches a window subscribed in
 *  `subscriber`: unscoped emissions reach everyone; otherwise the same
 *  user, and the same project when the emission is project-bound. */
export function sameAudience(subscriber: DataScope | undefined, source: DataScope | undefined): boolean {
	if (!source || !subscriber) return true;
	if (source.userId !== subscriber.userId) return false;
	if (!source.project) return true;
	return source.project.id === subscriber.project?.id;
}
