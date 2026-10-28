import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";

/**
 * THE ACCOUNTS STORE (accounts wave, owner-approved 2026-10-28): the people
 * who share one LearnHarness server on a trusted LAN. Accounts are created
 * by the admin (the first account, made on /setup); each person has a
 * password and their own data root under <base>/users/<id>/ — settings,
 * prompt overrides and projects. Keys stay shared and admin-managed.
 *
 * Passwords: scrypt (N=2^14, r=8, p=1, 16-byte salt, 64-byte key),
 * compared in constant time. Sessions: a random 32-byte token in an
 * HttpOnly cookie; only its SHA-256 is stored, so a leaked sessions file
 * opens nothing. Sessions live 30 days and slide on use.
 *
 * Small JSON files, read-modify-write like the chat records; writes go
 * through a temp file + rename.
 */

export interface Account {
	id: string;
	/** The login name: lowercase letters, digits, "-" and "_". */
	name: string;
	admin: boolean;
	createdAt: string;
}

interface StoredAccount extends Account {
	passwordHash: string;
}

interface AccountsFile {
	version: 1;
	accounts: StoredAccount[];
}

interface SessionRecord {
	userId: string;
	createdAt: string;
	expiresAt: string;
}

export const SESSION_COOKIE = "lh_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Re-stamp a session's expiry at most this often (sliding without a
 *  write per request). */
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;
const NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const MIN_PASSWORD_LENGTH = 8;

const accountsFile = () => path.join(PATHS.data, "accounts.json");
const sessionsFile = () => path.join(PATHS.data, "sessions.json");

/** The account's data root (settings, prompts, projects). */
export function accountRoot(id: string): string {
	if (!/^usr_[a-z0-9-]+$/.test(id)) throw new Error(`Invalid account id: ${id}`);
	return path.join(PATHS.data, "users", id);
}

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, "\t"), { encoding: "utf-8", mode: 0o600 });
	fs.renameSync(tmp, file);
}

function readAccounts(): StoredAccount[] {
	const file = readJson<Partial<AccountsFile>>(accountsFile(), {});
	return Array.isArray(file.accounts) ? file.accounts : [];
}

function writeAccounts(accounts: StoredAccount[]): void {
	writeJson(accountsFile(), { version: 1, accounts } satisfies AccountsFile);
}

const publicAccount = ({ passwordHash: _hash, ...account }: StoredAccount): Account => account;

// ─── Passwords ───────────────────────────────────────────────────────────────

export function hashPassword(password: string): string {
	const salt = crypto.randomBytes(16);
	const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
	return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
	const [scheme, n, r, p, salt, key] = stored.split("$");
	if (scheme !== "scrypt" || !salt || !key) return false;
	const expected = Buffer.from(key, "base64");
	const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length, {
		N: Number(n),
		r: Number(r),
		p: Number(p),
	});
	return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A usable login name (normalized), or null. */
export function cleanAccountName(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const name = raw.trim().toLowerCase();
	return NAME.test(name) ? name : null;
}

export function passwordProblem(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length < MIN_PASSWORD_LENGTH) {
		return `A password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
	}
	return raw.length > 200 ? "That password is too long." : null;
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export function listAccounts(): Account[] {
	return readAccounts().map(publicAccount);
}

export function hasAccounts(): boolean {
	return readAccounts().length > 0;
}

export function getAccount(id: string): Account | null {
	const found = readAccounts().find((a) => a.id === id);
	return found ? publicAccount(found) : null;
}

export function createAccount(name: string, password: string, admin: boolean): Account {
	const accounts = readAccounts();
	if (accounts.some((a) => a.name === name)) throw new Error(`An account named "${name}" already exists.`);
	const account: StoredAccount = {
		id: `usr_${crypto.randomUUID()}`,
		name,
		admin,
		createdAt: new Date().toISOString(),
		passwordHash: hashPassword(password),
	};
	writeAccounts([...accounts, account]);
	fs.mkdirSync(accountRoot(account.id), { recursive: true });
	return publicAccount(account);
}

/** The account a name + password open, or null (no hint which was wrong). */
export function verifyLogin(name: string, password: string): Account | null {
	const account = readAccounts().find((a) => a.name === name);
	if (!account) {
		// Same work either way: an unknown name costs one hash too.
		hashPassword(password);
		return null;
	}
	return verifyPasswordHash(password, account.passwordHash) ? publicAccount(account) : null;
}

export function setPassword(id: string, password: string): boolean {
	const accounts = readAccounts();
	const account = accounts.find((a) => a.id === id);
	if (!account) return false;
	account.passwordHash = hashPassword(password);
	writeAccounts(accounts);
	return true;
}

export function checkPassword(id: string, password: string): boolean {
	const account = readAccounts().find((a) => a.id === id);
	return !!account && verifyPasswordHash(password, account.passwordHash);
}

/** Delete an account, its sessions and its whole data root. */
export function deleteAccount(id: string): boolean {
	const accounts = readAccounts();
	if (!accounts.some((a) => a.id === id)) return false;
	writeAccounts(accounts.filter((a) => a.id !== id));
	endSessionsOf(id);
	fs.rmSync(accountRoot(id), { recursive: true, force: true });
	return true;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

function readSessions(): Record<string, SessionRecord> {
	const raw = readJson<Record<string, SessionRecord>>(sessionsFile(), {});
	return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function writeSessions(sessions: Record<string, SessionRecord>): void {
	writeJson(sessionsFile(), sessions);
}

/** Open a session; returns the cookie token (never stored in clear). */
export function createSession(userId: string, now = Date.now()): string {
	const token = crypto.randomBytes(32).toString("base64url");
	const sessions = readSessions();
	for (const [key, s] of Object.entries(sessions)) if (Date.parse(s.expiresAt) <= now) delete sessions[key];
	sessions[tokenHash(token)] = {
		userId,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
	};
	writeSessions(sessions);
	return token;
}

/** The live account a session token belongs to (sliding expiry), or null. */
export function sessionAccount(token: string | undefined, now = Date.now()): Account | null {
	if (!token) return null;
	const sessions = readSessions();
	const key = tokenHash(token);
	const session = sessions[key];
	if (!session) return null;
	const expires = Date.parse(session.expiresAt);
	if (!(expires > now)) {
		delete sessions[key];
		writeSessions(sessions);
		return null;
	}
	const account = getAccount(session.userId);
	if (!account) return null;
	if (expires - now < SESSION_TTL_MS - SESSION_REFRESH_MS) {
		session.expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
		writeSessions(sessions);
	}
	return account;
}

export function endSession(token: string | undefined): void {
	if (!token) return;
	const sessions = readSessions();
	const key = tokenHash(token);
	if (!(key in sessions)) return;
	delete sessions[key];
	writeSessions(sessions);
}

/** End every session of an account (password reset, deletion). */
export function endSessionsOf(userId: string, keepToken?: string): void {
	const sessions = readSessions();
	const keep = keepToken ? tokenHash(keepToken) : undefined;
	let changed = false;
	for (const [key, s] of Object.entries(sessions)) {
		if (s.userId === userId && key !== keep) {
			delete sessions[key];
			changed = true;
		}
	}
	if (changed) writeSessions(sessions);
}
