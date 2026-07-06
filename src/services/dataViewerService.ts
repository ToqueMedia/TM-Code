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

import { invoke } from '@/utils/invokeMetrics'
import { tauriFetch } from './tauriFetch'
import { resolveWorkerUrl } from '../utils/devUrls'

/** Discriminated BLOB marker emitted by the Rust dev path — the prod path
 *  doesn't surface BLOBs structurally yet (worker returns raw rows), but
 *  the renderer treats both paths uniformly via the type guard below. */
export interface BlobMarker {
  __binary: number
}

export type Cell = null | number | string | boolean | BlobMarker

/** Narrow check for the BLOB sentinel — used by the table renderer to pick
 *  the `<binary, N bytes>` muted-pill style without resorting to substring
 *  detection on stringified values (the previous shape was fragile against
 *  legitimate TEXT rows that happened to match the sentinel format). */
export function isBlobMarker(cell: Cell): cell is BlobMarker {
  return (
    typeof cell === 'object' &&
    cell !== null &&
    typeof (cell as { __binary?: unknown }).__binary === 'number'
  )
}

export interface QueryResult {
  columns: string[]
  rows: Cell[][]
  rowIds?: Cell[]
}

export interface ColumnInfo {
  name: string
  type: string
  notNull: boolean
  isPrimaryKey: boolean
}

export interface MutationResult {
  rowsAffected?: number
}

export type RowValues = Record<string, Cell>

export type SortDirection = 'asc' | 'desc'

export interface RowQueryOptions {
  filter?: string
  sort?: {
    column: string
    direction: SortDirection
  } | null
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
 * Detect which sources are available for the current project.
 *
 * Dev is always available (local SQLite database). The Rust command scans
 * for any *.db, *.sqlite, *.sqlite3 file in common subdirectories.
 *
 * Prod is only available when the project has local inspection credentials
 * (TMDB_URL + TMDB_TOKEN in .env), usually from explicit provision_database
 * preflight/repair.
 */
export async function detectSources(project: ProjectContext): Promise<SourceDetectionResult> {
  // Dev is always available; generated apps use local SQLite (`file:./dev.db`).
  // Publish/deploy injects runtime DB credentials into the hosted app, but
  // does not make local IDE inspection credentials available by itself.
  const env = await invoke<Record<string, string>>('read_env_vars', {
    projectPath: project.path,
    keys: ['TMDB_URL', 'TMDB_TOKEN'],
  }).catch(() => ({} as Record<string, string>))
  const hasProdConfig = !!(env.TMDB_URL && env.TMDB_TOKEN)
  return { hasDevDb: true, hasProdConfig }
}

/**
 * Check whether a local dev database actually exists.
 * Returns false when the Dev source is selected but no DB file was found —
 * the DataViewer shows a "no database" empty state instead of loading forever.
 */
export async function hasDevDatabase(projectPath: string): Promise<boolean> {
  return invoke<boolean>('has_database_file', { projectPath }).catch(() => false)
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

async function devExecute(
  projectPath: string,
  sql: string,
  params: unknown[] = [],
): Promise<MutationResult> {
  return invoke<MutationResult>('data_viewer_dev_execute', {
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
      'Production database inspection is not configured locally. Run explicit `provision_database` preflight/repair to write TMDB_URL/TMDB_TOKEN for the IDE, or switch the source to DEV.',
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

async function prodExecute(
  project: ProjectContext,
  sql: string,
  params: unknown[] = [],
): Promise<MutationResult> {
  const env = await loadProdEnv(project.path)
  const url = resolveProdDbUrl(env, project.id)
  const res = await tauriFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.token}`,
    },
    body: JSON.stringify({ sql, params, method: 'run' }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Worker mutation failed (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  return {}
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

function countCacheKey(source: 'dev' | 'prod', projectId: string, table: string, filter: string): string {
  return `${cacheKey(source, projectId, table)}::filter=${filter}`
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
    const prefix = cacheKey(source, projectId, table)
    for (const k of countCache.keys()) if (k.startsWith(prefix)) countCache.delete(k)
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

/**
 * Sentinel thrown when libSQL/Turso returns an empty result for
 * `PRAGMA table_info(...)`. The libSQL fork is supposed to support
 * PRAGMA verbatim (it's SQLite under the hood), but some pipeline
 * versions and some hrana protocol revisions have refused PRAGMA in the
 * past; if that surfaces in production, the viewer needs to give the
 * user a non-cryptic error instead of silently rendering "No columns".
 *
 * Empty result on the DEV path is genuinely "the table has no columns"
 * (impossible in well-formed SQLite, but treat as no-data for safety) —
 * we only escalate to this error on the PROD path where the libSQL
 * driver is the unknown variable.
 */
export class PragmaUnsupportedError extends Error {
  constructor(table: string) {
    super(
      `PRAGMA table_info("${table}") returned no rows from the worker. ` +
      `This is the symptom of a libSQL pipeline that doesn't accept ` +
      `PRAGMA on the /v2/pipeline endpoint. Switch the source to DEV to ` +
      `inspect a local snapshot, or report this so the worker can be ` +
      `updated to expose column metadata directly.`,
    )
    this.name = 'PragmaUnsupportedError'
  }
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
    if (info.length === 0) {
      // Don't cache: another retry against the same table might land
      // on a different worker instance / libSQL revision that returns
      // proper data. Caching the empty result would lock the user out
      // until the IDE restart.
      throw new PragmaUnsupportedError(table)
    }
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
  filter: string = '',
): Promise<number> {
  assertTableName(table)
  const normalizedFilter = filter.trim()
  const key = countCacheKey(source, project.id, table, normalizedFilter)
  const cached = countCache.get(key)
  if (cached !== undefined) return cached

  const tableInfo = normalizedFilter ? await getTableInfo(source, project, table) : []
  const { clause, params } = buildFilterClause(tableInfo, normalizedFilter)
  const sql = `SELECT COUNT(*) FROM ${quoteIdent(table)}${clause}`
  let total: number
  if (source === 'dev') {
    const result = await devQuery(project.path, sql, params)
    total = Number(result.rows[0]?.[0] ?? 0)
  } else {
    const { rows } = await prodQuery(project, sql, params)
    total = Number(rows[0]?.[0] ?? 0)
  }
  countCache.set(key, total)
  return total
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function buildFilterClause(columnInfo: ColumnInfo[], filter: string): { clause: string; params: string[] } {
  const normalized = filter.trim()
  if (!normalized || columnInfo.length === 0) return { clause: '', params: [] }
  const searchable = columnInfo.map(c => c.name).filter(Boolean)
  if (searchable.length === 0) return { clause: '', params: [] }
  const like = `%${escapeLike(normalized)}%`
  return {
    clause: ` WHERE ${searchable.map(c => `CAST(${quoteIdent(c)} AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ')}`,
    params: searchable.map(() => like),
  }
}

async function buildOrderClause(
  source: 'dev' | 'prod',
  project: ProjectContext,
  table: string,
  sort: RowQueryOptions['sort'],
): Promise<string> {
  if (!sort?.column) return ''
  const columnInfo = await getTableInfo(source, project, table)
  if (!columnInfo.some(c => c.name === sort.column)) return ''
  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC'
  return ` ORDER BY ${quoteIdent(sort.column)} ${direction}`
}

export async function getRows(
  source: 'dev' | 'prod',
  project: ProjectContext,
  table: string,
  page: number,
  pageSize: number,
  options: RowQueryOptions = {},
): Promise<QueryResult> {
  assertTableName(table)
  const safePage = Math.max(1, Math.floor(page))
  const safeSize = Math.max(1, Math.min(500, Math.floor(pageSize)))
  const offset = (safePage - 1) * safeSize
  const columnInfo = await getTableInfo(source, project, table)
  const { clause, params: filterParams } = buildFilterClause(columnInfo, options.filter ?? '')
  const orderClause = await buildOrderClause(source, project, table, options.sort ?? null)
  const primaryKeys = columnInfo.filter(c => c.isPrimaryKey)
  const includeRowId = primaryKeys.length === 0
  const selectList = includeRowId ? `_rowid_ AS "__tmcode_rowid__", *` : '*'
  const sql = `SELECT ${selectList} FROM ${quoteIdent(table)}${clause}${orderClause} LIMIT ? OFFSET ?`
  const params = [...filterParams, safeSize, offset]

  if (source === 'dev') {
    const result = await devQuery(project.path, sql, params)
    return stripInternalRowIds(result, includeRowId)
  }

  // Prod path: worker returns rows only — fetch columns separately.
  // `getTableInfo` uses the schema cache so this no longer round-trips the
  // worker on every page change for the same table.
  const { rows } = await prodQuery(project, sql, params)
  const result = {
    columns: includeRowId ? ['__tmcode_rowid__', ...columnInfo.map((c) => c.name)] : columnInfo.map((c) => c.name),
    rows,
  }
  return stripInternalRowIds(result, includeRowId)
}

function stripInternalRowIds(result: QueryResult, includeRowId: boolean): QueryResult {
  if (!includeRowId) return result
  return {
    columns: result.columns.slice(1),
    rows: result.rows.map(row => row.slice(1)),
    rowIds: result.rows.map(row => row[0] ?? null),
  }
}

function editableColumns(columnInfo: ColumnInfo[]): ColumnInfo[] {
  return columnInfo.filter(c => !/\bBLOB\b/i.test(c.type))
}

function buildSetClause(columnInfo: ColumnInfo[], values: RowValues): { clause: string; params: Cell[] } {
  const entries = editableColumns(columnInfo).filter(c => Object.prototype.hasOwnProperty.call(values, c.name))
  if (entries.length === 0) {
    throw new Error('No editable columns were provided.')
  }
  return {
    clause: entries.map(c => `${quoteIdent(c.name)} = ?`).join(', '),
    params: entries.map(c => values[c.name]),
  }
}

function buildRowWhereClause(
  columnInfo: ColumnInfo[],
  originalValues: RowValues,
  rowId?: Cell | null,
): { clause: string; params: Cell[] } {
  const primaryKeys = columnInfo.filter(c => c.isPrimaryKey)
  if (primaryKeys.length > 0) {
    return {
      clause: primaryKeys.map(c => `${quoteIdent(c.name)} IS ?`).join(' AND '),
      params: primaryKeys.map(c => originalValues[c.name] ?? null),
    }
  }

  if (rowId !== undefined && rowId !== null) {
    return { clause: '_rowid_ IS ?', params: [rowId] }
  }

  throw new Error('This row cannot be edited because the table has no primary key and no rowid.')
}

async function executeMutation(
  source: 'dev' | 'prod',
  project: ProjectContext,
  table: string,
  sql: string,
  params: Cell[],
): Promise<MutationResult> {
  assertTableName(table)
  if (source === 'dev') {
    return devExecute(project.path, sql, params)
  }
  return prodExecute(project, sql, params)
}

export async function insertRow(
  source: 'dev' | 'prod',
  project: ProjectContext,
  table: string,
  columnInfo: ColumnInfo[],
  values: RowValues,
): Promise<MutationResult> {
  assertTableName(table)
  const entries = editableColumns(columnInfo).filter(c => Object.prototype.hasOwnProperty.call(values, c.name))
  const sql = entries.length === 0
    ? `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`
    : `INSERT INTO ${quoteIdent(table)} (${entries.map(c => quoteIdent(c.name)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`
  const params = entries.map(c => values[c.name])
  const result = await executeMutation(source, project, table, sql, params)
  invalidateCache(source, project.id, table)
  return result
}

export async function updateRow(
  source: 'dev' | 'prod',
  project: ProjectContext,
  table: string,
  columnInfo: ColumnInfo[],
  originalValues: RowValues,
  rowId: Cell | null | undefined,
  values: RowValues,
): Promise<MutationResult> {
  const set = buildSetClause(columnInfo, values)
  const where = buildRowWhereClause(columnInfo, originalValues, rowId)
  const sql = `UPDATE ${quoteIdent(table)} SET ${set.clause} WHERE ${where.clause}`
  const result = await executeMutation(source, project, table, sql, [...set.params, ...where.params])
  invalidateCache(source, project.id, table)
  return result
}

export async function deleteRow(
  source: 'dev' | 'prod',
  project: ProjectContext,
  table: string,
  columnInfo: ColumnInfo[],
  originalValues: RowValues,
  rowId?: Cell | null,
): Promise<MutationResult> {
  const where = buildRowWhereClause(columnInfo, originalValues, rowId)
  const sql = `DELETE FROM ${quoteIdent(table)} WHERE ${where.clause}`
  const result = await executeMutation(source, project, table, sql, where.params)
  invalidateCache(source, project.id, table)
  return result
}
