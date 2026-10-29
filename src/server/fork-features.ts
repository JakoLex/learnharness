/**
 * FORK SWITCHES (owner, 2026-10-29, upstream 0.4.0 merge): this fork keeps
 * two upstream features OFF.
 *
 * - The custom endpoint: upstream registers ONE process-wide custom
 *   provider from the settings it reads at boot and before every model
 *   operation. Settings here are per account, so one account's endpoint
 *   (and key) would replace or leak into another's, and the boot read has
 *   no account scope at all. The LAN fleet rides local-providers.ts instead.
 * - Claude Code: it would put the host's Claude subscription behind every
 *   account; the owner turned it off for everyone, admin included.
 *
 * The code stays for clean upstream merges. LH_CUSTOM_ENDPOINT=1 /
 * LH_CLAUDE_CODE=1 turn a feature on; unset means off — except under
 * NODE_ENV=test, where upstream's own tests keep exercising the code.
 * The custom endpoint never runs with accounts on (LH_ACCOUNTS=1, see
 * accountsEnabled in scope.ts): without accounts there is one local user,
 * which is the setup upstream built it for — so its routes need no scope.
 */
function on(name: string): boolean {
	const value = process.env[name];
	if (value !== undefined) return value === "1";
	return process.env.NODE_ENV === "test";
}

export function customEndpointFeature(): boolean {
	return on("LH_CUSTOM_ENDPOINT") && process.env.LH_ACCOUNTS !== "1";
}

export function claudeCodeFeature(): boolean {
	return on("LH_CLAUDE_CODE");
}

/** What the settings UI may offer (GET /api/keys `features`). */
export interface ForkFeatureFlags {
	customEndpoint: boolean;
	claudeCode: boolean;
}

export function forkFeatureFlags(): ForkFeatureFlags {
	return { customEndpoint: customEndpointFeature(), claudeCode: claudeCodeFeature() };
}
