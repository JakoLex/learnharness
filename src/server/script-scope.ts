import { runInDataScope } from "../store/data-scope.ts";
import { getProject, listProjects } from "../store/projects.ts";
import { listAccounts } from "../store/accounts.ts";
import { accountUser, accountsEnabled, ensureUserLayout, localUser, scopeFor } from "./scope.ts";

/**
 * CLI SCRIPTS IN A PROJECT (projects wave, owner-approved 2026-10-28):
 * scripts/import-notes.ts, backfill-graph.ts and replay-layout.ts run
 * outside any request, so they name their project with `--project <id>`
 * (and, with accounts on, its owner with `--user <name>`).
 * The flag is removed from process.argv before the script reads its own
 * positional arguments. LH_FLAT_DATA=1 keeps the pre-projects flat layout
 * for a data dir that never migrated.
 */
export function runScriptInProject(main: () => unknown): void {
	if (process.env.LH_FLAT_DATA === "1") {
		void main();
		return;
	}
	const args = process.argv.slice(2);
	// Accounts mode: --user <name> picks whose project (accounts wave).
	let user = localUser();
	if (accountsEnabled()) {
		const u = args.indexOf("--user");
		const name = u >= 0 ? args[u + 1] : undefined;
		const account = listAccounts().find((a) => a.name === name);
		if (!account) {
			console.error(`Name the account: --user <name>${name ? ` (no account "${name}")` : ""}\n${listAccounts().map((a) => `  ${a.name}`).join("\n")}`);
			process.exit(2);
		}
		args.splice(u, 2);
		user = accountUser(account);
	}
	const at = args.indexOf("--project");
	const projectId = at >= 0 ? args[at + 1] : undefined;
	ensureUserLayout(user.userRoot);
	const project = projectId ? getProject(user.userRoot, projectId) : null;
	if (!project) {
		const known = listProjects(user.userRoot).map((p) => `  ${p.id}  ${p.name}`).join("\n");
		console.error(`Name the project: --project <id>${projectId ? ` (no project "${projectId}")` : ""}\n${known || "  (no projects yet)"}`);
		process.exit(2);
	}
	args.splice(at, 2);
	process.argv = [process.argv[0]!, process.argv[1]!, ...args];
	void runInDataScope(scopeFor(user, project), main);
}
