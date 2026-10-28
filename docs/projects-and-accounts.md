# Projects and accounts

Owner-approved 2026-10-28. One server can hold several people (accounts), and every person can hold several **projects**, OpenScience-style. Each project is a separate workspace with its own sessions and **its own knowledge graph**. This is a deliberate fork divergence from the upstream "one cross-domain graph" vision.

## Data layout

```
<LH_DATA_DIR>/
  accounts.json, sessions.json        accounts mode only
  users/<usr_id>/                     accounts mode: one root per person
  settings.json, prompts/, projects/  without accounts: the local user's root is the base itself
<user root>/
  settings.json, prompts/             per person: models (slots + fallbacks), agent, appearance, …
  projects/prj_<id>/
    project.json                      name, createdAt, archivedAt?
    chats/ graph/ jobs/ debug/        everything project-bound
```

API keys and provider logins (`auth.json`, the credential files beside it) stay **shared and global**. Only the admin can manage them.

## Scoping

- `src/store/data-scope.ts` holds an `AsyncLocalStorage` DataScope `{userId, admin, userRoot, project?}`. `config.ts` resolves every mutable path through it (`PATHS.chats/graph/jobs/debug`, `LEDGER_FILES`, `sourcesFile()`, `settingsFile()`, `promptsOverrideDir()`, …).
- Work a request starts inherits its scope. That covers extraction, jobs, wake turns and compaction.
- Unscoped access is a loud error in a running server. Under tests (and with `LH_FLAT_DATA=1`) it falls back to the old flat layout at the base.
- Route handlers are wrapped with `scoped(handler, { project, admin? })` from `src/server/scope.ts`. `project` is one of:
  - `"required"`: chats, graph, jobs, activity.
  - `"optional"`: events.
  - `"none"`: settings, models, projects, auth.
- The client names the project with the `x-lh-project` header (`components/api-fetch.ts`). EventSource and download links can't set headers, so they use `?project=`.
- Pages use `withPageScope(projectId, fn)`.
- Process registries are keyed per project graph: extraction runs, the single-flight guard, the audit lock and the recovery-sweep throttle. A notes file imported into two projects therefore never collides.
- SSE windows only receive events from their own user and project, plus process-wide ones such as provider outages.

## Projects

- `/` is the project list: sessions count and last activity, newest first. It offers New project, Rename, Archive/Restore (archived projects sit behind a toggle) and Delete. Delete is refused with 409 while anything still runs in the project.
- A project lives under `/p/<id>` (its graph home) and `/p/<id>/chat/<chatId>`. The sidebar header shows the project name and a way back to the list.
- Old `/chat/<id>` links redirect into the project that holds the chat.
- **Migration:** on first touch, a user root that still has the flat `chats/ graph/ jobs/ debug/` gets them moved into a project named "My project". It's a same-filesystem rename, nothing is copied.
- CLI scripts (`import-notes`, `backfill-graph`, `replay-layout`) take `--project <id>`, plus `--user <name>` when accounts are on.

## Accounts (`LH_ACCOUNTS=1`)

- Off by default. The desktop app and plain dev run as one local admin user with no login.
- **First visit:** `/setup` creates the admin, who takes over the existing data: the flat layout becomes "My project", and `settings.json`, `prompts/` and `projects/` move into the admin's root.
- **Admin only:** creates accounts (name plus starting password), resets passwords (which signs that person out) and deletes accounts with all their data (never their own). A new account starts with a copy of the admin's models section (slots and fallbacks) and no projects.
- **Sign-in:**
  - Passwords are hashed with scrypt.
  - The session is an `lh_session` cookie (HttpOnly, SameSite=Lax, 30 days, sliding). Only the token's SHA-256 is stored.
  - A failed attempt answers after a short pause.
  - `proxy.ts` only checks that the cookie is present: pages redirect to `/login`, APIs answer 401. Every route and page then verifies the session itself (`requestUser`).
- **Everyone** can change their own password (which ends their other sessions) and sign out (Settings → Account). Settings, prompt overrides and projects are per person.
- **Host file access:** the file tools (`read`, `ls`, `find`, `grep`) and the `pdf` job read the server's filesystem, so only the admin's agents get them. Others bring material in through notes import and attachments. The researcher's web-PDF reader stays available to everyone.
- **Keys and provider logins** (Settings → Providers) are visible to and editable by the admin only.

The trust model is trusted people on a LAN. This separates data and keeps keys and the host filesystem away from non-admins. It is not internet-facing multi-tenant hosting: there is no HTTPS, rate limiting or audit log.
