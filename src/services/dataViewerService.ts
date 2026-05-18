/**
 * Data Viewer service. Abstracts dev (local SQLite via Rust) and prod
 * (TM Code Worker → Turso libSQL) behind a uniform `{ columns, rows }` shape.
 *
 * Dev path: `data_viewer_dev_query` Rust command. Returns columns + rows
 *           together; SELECT/PRAGMA-only gate enforced server-side.
 *
 * Prod path: POST `{workerUrl}/v1/apps/{projectId}/db` with the per-app
 *            TMDB_TOKEN read from the project's `.env`. The worker returns
 *            `{ rows }` (no column names), so a separate `PRAGMA table_info`
 *            call provides the column metadata.
 */

import { invoke } from '@tauri-apps/api/core'
import { tauriFetch } from './tauriFetch'
import { resolveWorkerUrl } from '../utils/devUrls'

export type Cell = null | number | string | boolean

export interface QueryResult {
  columns: string[]
  rows: Cell[][]
}

export interface ColumnInfo {
  name: string
  type: string
  notNull: boolean
  isPrimaryKey: boolean
}

export interface ProjectContext {
  /** Filesystem path to the project root (for the dev path). */
  path: string
  /** TM Code project ID (for the prod path). */
  id: string
  /** Display name (header / breadcrumbs). */
  name: string
}

// Relaxed identifier: the first char is a letter/underscore; the rest can
// include hyphens (drizzle-generated tables sometimes carry them), digits,
// dots (rare, but Turso allows attached-DB qualifiers like `main.users`),
// and dollar signs (SQLite legacy). Excludes anything that lets `"` or
// whitespace into the composed query — those would break the
// `"<table>"` quoting we use everywhere and let crafted names inject SQL.
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_\-.$]*$/

/** Guard against SQL injection via crafted table names — see PLAN-DATA-VIEWER.md §6.
 *  Also escapes embedded `"` (SQLite identifier escape: `""`) so quoting the
 *  name in template strings stays safe even when the validator widens later. */
function assertTableName(table: string): void {
  if (!TABLE_NAME_RE.test(table)) {
    throw new Error(`Invalid table name: ${table}`)
  }
}

function quoteIdent(name: string): string {
  // Double any embedded `"` per SQLite identifier escape rules. Defensive —
  // the regex above already excludes `"`, but the escape protects against
  // future regex relaxations and self-documents the contract.
  return `"${name.replace(/"/g, '""')}"`
}

// ─── Source detection ────────────────────────────────────────────────────────

export interface SourceDetectionResult {
  hasDevDb: boolean
  hasProdConfig: boolean
}

/**
 * Detect which sources are available for the current project. The viewer
 * uses this to choose a sensible default and to disable the toggle when only
 * one side is set up.
 *
 * `hasDevDb`     — `dev.db` exists at the project root.
 * `hasProdConfig` — `TMDB_URL` AND `TMDB_TOKEN` are both present in `.env`.
 */
export async function detectSources(project: ProjectContext): Promise<SourceDetectionResult> {
  const [hasDevDb, env] = await Promise.all([
    invoke<boolean>('path_exists', { path: `${project.path}/dev.db` }).catch(() => false),
    invoke<Record<string, string>>('read_env_vars', {
      projectPath: project.path,
      keys: ['TMDB_URL', 'TMDB_TOKEN'],
    }).catch(() => ({} as Record<string, string>)),
  ])
  const hasProdConfig = !!(env.TMDB_URL && env.TMDB_TOKEN)
  return { hasDevDb, hasProdConfig }
}

// ─── Dev path ────────────────────────────────────────────────────────────────

async function devQuery(
  projectPath: string,
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult> {
  return invoke<QueryResult>('data_viewer_dev_query', {
    projectPath,
    sql,
    params,
  })
}

// ─── Prod path ───────────────────────────────────────────────────────────────

interface ProdEnv {
  url: string
  token: string
}

async function loadProdEnv(projectPath: string): Promise<ProdEnv> {
  const env = await invoke<Record<string, string>>('read_env_vars', {
    projectPath,
    keys: ['TMDB_URL', 'TMDB_TOKEN'],
  })
  if (!env.TMDB_URL || !env.TMDB_TOKEN) {
    throw new Error(
      'Database not provisioned. Run `provision_database` in chat, or switch the source to DEV.',
    )
  }
  return { url: env.TMDB_URL, token: env.TMDB_TOKEN }
}

/** Resolve the worker DB endpoint, preferring `TMDB_URL` (the worker proxy URL the
 * agent wrote) and falling back to the IDE-side worker URL — the two normally
 * point at the same backend. */
function resolveProdDbUrl(env: ProdEnv, projectId: string): string {
  if (env.url && env.url.startsWith('http')) {
    return env.url.replace(/\/+$/, '')
  }
  return `${resolveWorkerUrl()}/v1/apps/${encodeURIComponent(projectId)}/db`
}

async function prodQuery(
  project: ProjectContext,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Cell[][] }> {
  const env = await loadProdEnv(project.path)
  const url = resolveProdDbUrl(env, project.id)
  const res = await tauriFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.token}`,
    },
    body: JSON.stringify({ sql, params, method: 'all' }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Worker query failed (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as { rows?: unknown[] }
  const rows = Array.isArray(data.rows) ? (data.rows as Cell[][]) : []
  return { rows }
}

// ─── Cache ──────────────────────────────────────────────────────────────────
//
// In-memory memoization for the two reads that are stable between pages of
// the same table: PRAGMA table_info (schema) and SELECT COUNT(*) (total row
// count). The cache is keyed by (source, projectId[, table]) so different
// sources / projects don't poison each other.
//
// Why we cache:
//   • Pagination navigates pages of the SAME table — the column list never
//     changes between pages, so PRAGMA on every page is wasted IPC (dev) or
//     a wasted billable libSQL roundtrip (prod, against the worker rate
//     limit per PLAN-DATA-VIEWER.md §9).
//   • COUNT(*) on a large Turso table is expensive — caching until the user
//     hits Refresh keeps browsing snappy.
//
// Invalidation is explicit: `invalidateCache(source, projectId, table?)`
// drops the row count + schema entry. The "Refresh" button in the viewer
// calls this before re-firing the network/IPC. We deliberately do NOT
// timeout-expire entries — stale data only becomes a problem when the agent
// edits the schema, and the agent flow already requires the user to refresh
// the viewer manually after the edit completes.

const tablesCache = new Map<string, string[]>()
const schemaCache = new Map<string, ColumnInfo[]>()
const countCache = new Map<string, number>()

function cacheKey(source: 'dev' | 'prod', projectId: string, table?: string): string {
  return table ? `${source}::${projectId}::${table}` : `${source}::${projectId}`
}

/**
 * Drop cached entries scoped to one source + project (and optionally one
 * table). Called when the user hits "Refresh tables" or "Refresh rows" and
 * also exposed for future callers that mutate the DB schema.
 */
export function invalidateCache(
  source: 'dev' | 'prod',
  projectId: string,
  table?: string,
): void {
  if (table) {
    schemaCache.delete(cacheKey(source, projectId, table))
    countCache.delete(cacheKey(source, projectId, table))
    return
  }
  // Whole-project invalidation: drop the table list AND every per-table
  // entry that starts with our prefix.
  tablesCache.delete(cacheKey(source, projectId))
  const prefix = cacheKey(source, projectId) + '::'
  for (const k of schemaCache.keys()) if (k.startsWith(prefix)) schemaCache.delete(k)
  for (const k of countCache.keys()) if (k.startsWith(prefix)) countCache.delete(k)
}

// ─── Public API ──────────────────────────────────────────────────────────────

const SYSTEM_TABLE_PREFIXES = ['sqlite_', '__drizzle_', 'libsql_']

function filterUserTables(names: string[]): string[] {
  return names
    .filter((n) => !SYSTEM_TABLE_PREFIXES.some((p) => n.startsWith(p)))
    .sort((a, b) => a.localeCompare(b))
}

const LIST_TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

export async function listTables(
  source: 'dev' | 'prod',
  project: ProjectContext,
): Promise<string[]> {
  const key = cacheKey(source, project.id)
  const cached = tablesCache.get(key)
  if (cached) return cached

  let names: string[]
  if (source === 'dev') {
    const result = await devQuery(project.path, LIST_TABLES_SQL)
    names = result.rows.map((r) => String(r[0] ?? ''))
  } else {
    const { rows } = await prodQuery(project, LIST_TABLES_SQL)
    names = rows.map((r) => String(r[0] ?? ''))
  }
  const filtered = filterUserTables(names)
  tablesCache.set(key, filtered)
  return filtered
}

export async function getTableInfo(
  source: 'dev' | 'prod',
  project: ProjectContext,
  table: string,
): Promise<ColumnInfo[]> {
  assertTableName(table)
  const key = cacheKey(source, project.id, table)
  const cached = schemaCache.get(key)
  if (cached) return cached

  const sql = `PRAGMA table_info(${quoteIdent(table)})`
  let info: ColumnInfo[]
  if (source === 'dev') {
    const result = await devQuery(project.path, sql)
    info = result.rows.map(rowToColumnInfo)
  } else {
    const { rows } = await prodQuery(project, sql)
    info = rows.map(rowToColumnInfo)
  }
  schemaCache.set(key, info)
  return info
}

function rowToColumnInfo(row: Cell[]): ColumnInfo {
  // PRAGMA table_info columns: [cid, name, type, notnull, dflt_value, pk]
  return {
    name: String(row[1] ?? ''),
    type: String(row[2] ?? ''),
    notNull: Number(row[3] ?? 0) === 1,
    isPrimaryKey: Number(row[5] ?? 0) > 0,
  }
}

export async function countRows(
  source: 'dev' | 'prod',
  project: ProjectContext,
  table: string,
): Promise<number> {
  assertTableName(table)
  const key = cacheKey(source, project.id, table)
  const cached = countCache.get(key)
  if (cached !== undefined) return cached

  const sql = `SELECT COUNT(*) FROM ${quoteIdent(table)}`
  let total: number
  if (source === 'dev') {
    const result = await devQuery(project.path, sql)
    total = Number(result.rows[0]?.[0] ?? 0)
  } else {
    const { rows } = await prodQuery(project, sql)
    total = Number(rows[0]?.[0] ?? 0)
  }
  countCache.set(key, total)
  return total
}

export async function getRows(
  source: 'dev' | 'prod',
  project: ProjectContext,
  table: string,
  page: number,
  pageSize: number,
): Promise<QueryResult> {
  assertTableName(table)
  const safePage = Math.max(1, Math.floor(page))
  const safeSize = Math.max(1, Math.min(500, Math.floor(pageSize)))
  const offset = (safePage - 1) * safeSize
  const sql = `SELECT * FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`
  const params = [safeSize, offset]

  if (source === 'dev') {
    return devQuery(project.path, sql, params)
  }

  // Prod path: worker returns rows only — fetch columns separately.
  // `getTableInfo` uses the schema cache so this no longer round-trips the
  // worker on every page change for the same table.
  const [columnInfo, { rows }] = await Promise.all([
    getTableInfo('prod', project, table),
    prodQuery(project, sql, params),
  ])
  return { columns: columnInfo.map((c) => c.name), rows }
}
