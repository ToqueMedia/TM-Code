# Data Viewer — Feature Spec

**Status:** Draft / not started
**Owner:** TBD
**Date:** 2026-05-18
**Estimated effort:** 3–5 days end-to-end (excluding polish)

---

## 1. Why

The agent now writes user data to two distinct stores depending on environment:

- **Dev**: `file:./dev.db` — a local SQLite file in the project directory, accessed by `drizzle-orm/libsql/node`.
- **Prod**: TM Code Database (Turso libSQL) — accessed by the deployed app via the worker proxy with Cloud Run-injected `TMDB_URL` + `TMDB_TOKEN`. Publish/deploy provisions or reuses Turso and applies the bundled schema/migrations there. `provision_database` is an explicit production preflight/repair or IDE-inspection path, not the normal local scaffolding path.

Today there is no in-IDE way to inspect either. Developers fall back to:

- Installing a local SQLite GUI (DBeaver, TablePlus) for dev — but every project picks its own dev.db path and pointing the external tool at the right file is friction.
- Logging into the Turso console for prod — but that exposes the platform-side database name (`app-{slug}`) and the per-DB Turso JWT, both of which the TM Code worker is supposed to hide. It also shows the wrong identity (the platform tenant, not the developer's app).

A built-in data viewer closes the gap: the developer stays in the IDE, the worker stays the only path to prod Turso, and the dev/prod switch is hidden from the user.

## 2. Scope (v1)

**In scope:**
- Read-only browse: list of tables → table view with paginated rows.
- Pagination: 10 / 20 / 50 / 100 rows per page.
- Column metadata: name + type from `PRAGMA table_info`.
- Dev/prod source toggle (auto-detected from `NODE_ENV` / project flags, manual override available).
- Full-screen view (like `SettingsView` / `ChatView`), reachable from a button beside Sessions in the chat header.

**Out of scope (v1):**
- Write/edit. No INSERT/UPDATE/DELETE from the viewer.
- Query editor. Pre-canned `SELECT * FROM <table>` only.
- Schema migrations / DDL. Drizzle-kit owns that path.
- Multi-app browsing. Viewer is scoped to the currently open project.
- Joins, aggregations, exports. Future.

## 3. UX

```
┌─────────────────────────────────────────────────────────────────┐
│  ChatView header                                                │
│  [≡] [SessionDropdown] [Data]  ←── new entry, beside Sessions   │
└─────────────────────────────────────────────────────────────────┘
                              ↓ click
┌─────────────────────────────────────────────────────────────────┐
│  DataViewerView (full-screen, layoutStore.viewMode='data')      │
│  ┌──────────────┬──────────────────────────────────────────────┐│
│  │ Tables       │  users          [DEV ▼]              [10▼]   ││
│  │  • users     │  ┌────┬───────┬───────────┬──────────────┐   ││
│  │    audit_log │  │ id │ email │ avatarUrl │ createdAt    │   ││
│  │    sessions  │  ├────┼───────┼───────────┼──────────────┤   ││
│  │              │  │ 1  │ a@…   │ null      │ 2026-05-18   │   ││
│  │              │  │ 2  │ b@…   │ /a.png    │ 2026-05-18   │   ││
│  │              │  └────┴───────┴───────────┴──────────────┘   ││
│  │              │  ‹  1 / 12  ›    showing 1–10 of 117         ││
│  └──────────────┴──────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

**Interaction notes:**
- Source toggle (`DEV` / `PROD`) is in the header next to the table name. Default = `DEV` (the dev SQLite file). Switch persists per-project in `localStorage`.
- Page-size selector (`10` / `20` / `50` / `100`) is in the top-right of the table area. Default = `20`.
- Pagination controls are bottom-centred (`‹  page X / Y  ›`) and standard.
- Tables sidebar is resizable like the chat sidebar in PreviewView.
- Empty state: "No tables yet. Run a migration with `npx drizzle-kit migrate` to create them."
- Error state: surface the raw error from the worker / SQLite driver so the agent can diagnose.

## 4. Architecture

### 4.1 Dev path (local SQLite file)

```
DataViewerView  ──invoke──▶  Rust command  ──open──▶  ./dev.db
                                       │
                                       └──▶  PRAGMA table_info / SELECT
```

Add a new Tauri command `data_viewer_dev_query`:

- Input: `{ projectPath: string, sql: string, params: unknown[] }`
- Output: `{ columns: string[], rows: unknown[][] }`
- Implementation: opens `<projectPath>/dev.db` via `rusqlite` (already vendored — check `Cargo.toml`; if not, add it). Read-only mode (`SQLITE_OPEN_READONLY`).
- Reject paths outside the project root (mirrors `validatePathWithinProject` in `toolExecutor.ts:679`).

Sub-commands the viewer needs:
- `data_viewer_dev_list_tables(projectPath)` → `['users', 'sessions', ...]` (`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%'`).
- `data_viewer_dev_table_info(projectPath, table)` → columns + types.
- `data_viewer_dev_query(projectPath, sql, params)` → rows + columns. Only allow `SELECT` statements (parser check on the leading keyword); reject `INSERT|UPDATE|DELETE|DROP|ALTER`.

Alternative: pass `sql + params` directly without sub-commands and gate on `SELECT` in Rust. Cleaner — fewer commands to register. **Pick this.**

### 4.2 Prod path (Turso via worker)

```
DataViewerView  ──fetch──▶  TM Code Worker  ──HTTP──▶  Turso libSQL
                  TMDB_TOKEN              platform JWT
```

The worker already exposes `POST /v1/apps/{projectId}/db` (single query) and `POST /v1/apps/{projectId}/db/batch` (transaction) under the TMDB token auth (see `toquemedia-studio-api/src/tursoDb.ts:handleDbQuery`).

The viewer can:
- Send `SELECT name FROM sqlite_master WHERE type='table'` to list tables.
- Send `PRAGMA table_info(<table>)` for column metadata.
- Send `SELECT * FROM <table> LIMIT ? OFFSET ?` for paginated rows.
- Send `SELECT COUNT(*) FROM <table>` for total row count (drives the `1 / 12` page count).

**Two TMDB_TOKEN sources to consider** (pick one in v1):

| Path | How | Pros | Cons |
|---|---|---|---|
| A — Read inspection creds from local `.env` | `await invoke('read_env_vars', { keys: ['TMDB_URL', 'TMDB_TOKEN'] })` | Matches the current IDE implementation and works after an explicit `provision_database` preflight/repair writes inspection creds locally. | Publish/deploy injects `TMDB_*` directly into Cloud Run and does not make those values a local scaffolding default. Without local inspection creds, PROD viewer stays disabled even though the deployed app can use its DB. |
| B — Mint a viewer-scoped token | New worker endpoint `POST /v1/apps/{projectId}/db/viewer-token` returning a short-lived read-only TMDB token | Read-only enforcement is server-side; viewer-only path can be killed without rotating the app's runtime token; works after Publish/deploy without writing `TMDB_*` to project `.env`. | New endpoint + token-issuance plumbing. |

Pick A for v1 because it matches the shipped service. B is the correct long-term shape if PROD browsing should work automatically after Publish/deploy without local `.env` inspection credentials. The worker's `handleDbQuery` already enforces method types (`all`/`get`/`run`/`values`); a write-rejection check in the viewer call site is enough.

### 4.3 Source selection

```ts
// Auto-detect priority order:
// 1. Manual override in localStorage (`data-viewer-source:{projectId}` → 'dev'|'prod')
// 2. Presence of dev.db file → 'dev' default
// 3. Presence of TMDB_URL + TMDB_TOKEN in local .env inspection creds → 'prod' available
// 4. Neither → empty state with local migration CTA; production persistence is handled by Publish/deploy
```

Detection result is shown in the source toggle; user can flip it manually at any time.

## 5. Components

```
src/components/views/DataViewerView.tsx           // full-screen view, mirrors SettingsView shape
src/components/data-viewer/
  TablesSidebar.tsx                                // left rail with table list
  TableView.tsx                                    // table header + paginated rows + page-size selector
  Pagination.tsx                                   // ‹ X / Y › control
  SourceToggle.tsx                                 // DEV / PROD switcher
  EmptyState.tsx                                   // "no tables yet" / "no project open" / "production DB unavailable"
```

State:
```
src/stores/dataViewerStore.ts                      // Zustand: { activeTable, page, pageSize, source }
```

Service:
```
src/services/dataViewerService.ts                  // listTables / tableInfo / query — abstracts dev vs prod
```

Rust:
```
src-tauri/src/commands/data_viewer.rs              // dev-only SQLite query command(s)
```

## 6. Pagination math

```
const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
const offset = (page - 1) * pageSize
const sql = `SELECT * FROM "${table}" LIMIT ? OFFSET ?`
const params = [pageSize, offset]
```

Use double-quotes around table names so identifiers with reserved words work. Reject table names that don't match `^[A-Za-z_][A-Za-z0-9_]*$` to keep the query injection-free.

Total row count: `SELECT COUNT(*) FROM "<table>"` once per table load (cached client-side until the user switches tables or hits Refresh).

## 7. Activity-bar / header integration

`ChatView.tsx` (around line 192 where the `HStack` of indicators lives, OR next to the `SessionDropdown` at line 184):

```tsx
<Box as="button" onClick={() => layoutStore.setViewMode('data')}>
  <FiDatabase size={15} />
</Box>
```

Add `'data'` to the `LayoutViewMode` union in `layoutStore.ts` and to the `currentView` switch in `CodeEditorNew.tsx` (the orchestrator).

## 8. Telemetry

Track sparingly:
- `data_viewer_opened` — once per view-mode change.
- `data_viewer_source_switched` — when user flips DEV ↔ PROD.
- `data_viewer_query_failed` — with the error class (network / sql / auth / not_provisioned).

No row-level telemetry — that would leak user data through the analytics pipe.

## 9. Risks / known gotchas

- **SQLite `BLOB` columns**: render as `<binary, N bytes>` placeholder. Don't try to display them.
- **Large rows (>4 KB JSON columns)**: truncate cell rendering at 200 chars with a "show full" expander.
- **Worker rate-limit on prod**: the per-app `db` endpoint has the same rate limit as the production app's queries. Heavy paginated browsing could collide with real traffic. v1: rely on the worker's existing limits; v2: dedicated `db-viewer` endpoint with separate budget.
- **Concurrent writes during browse**: SQLite WAL mode handles this for dev; Turso always handles it. Show a "stale" badge if `COUNT(*)` doesn't match the page-walked total.
- **`drizzle_*` tables / `sqlite_*` system tables**: hide from the list. They're plumbing, not user data.

## 10. Open questions

1. Should the viewer show **only** Drizzle-managed tables (those declared in `server/schema.ts`), or every table in the DB? v1 = every table that isn't `sqlite_*` / `__drizzle_*`. Simpler.
2. Do we need a "Refresh" button, or auto-poll? v1 = manual refresh only. Auto-polling on a paid Turso connection burns query budget.
3. Should the prod path use the same `TMDB_TOKEN` as user code, or mint a viewer-scoped token? See §4.2 — v1 picks the simpler path A.
4. Does the dev path need to start its own database connection, or can it reuse a long-lived `rusqlite::Connection` cached in Tauri state? v1: open-per-request (simpler); v2: cached connection if perf matters.

## 11. Build order

1. **Foundations** (½ day): `layoutStore` view-mode entry, `DataViewerView` shell, header button.
2. **Dev path** (1 day): Rust command + service + `TableView` rendering a hard-coded query result.
3. **Pagination + table list** (½ day): tables sidebar + pagination controls.
4. **Prod path** (1 day): worker request + source toggle + auto-detect.
5. **States + polish** (1 day): empty / error / loading states, telemetry, accessibility pass.

Total: ~4 days for a v1 that ships.
