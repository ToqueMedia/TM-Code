import { FileTreeService } from './fileTreeService'
import { FileService } from './fileService'
import FirebaseAuthService from './auth/firebaseAuth'
import { invoke } from '@/utils/invokeMetrics'
import { tauriFetch } from './tauriFetch'
import { buildTmCodeWebImportUrl, resolveWorkerUrl } from '@/utils/devUrls'
import { IS_VITE_DEV } from '@/utils/viteEnv'
import type { FileTreeNode } from '../types/fileTree'

type Capability = 'edit' | 'preview' | 'check' | 'deploy'
type Framework = 'react-vite' | 'react-vite-fullstack' | 'nextjs' | 'static-html' | 'vanilla-vite' | 'unsupported' | 'unknown'

interface PortableFile {
  path: string
  content: string
  /** 'base64' marks a binary asset (image/font/media) — content is base64. */
  encoding?: 'base64'
}

interface CompatibilityReport {
  importable: boolean
  framework: Framework
  capabilities: Capability[]
  entryRoot: string
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun'
  /** Backend Node folder ('server'/'backend') when the project is fullstack. */
  backendDir?: string
  /** Schema/migrations/SQLite deps present — Web deploy provisions a managed DB. */
  hasDatabase?: boolean
  blockers: string[]
  warnings: string[]
}

interface ExportPackage {
  schemaVersion: 1
  source: 'tm-code-ide'
  exportedAt: string
  projectName: string
  rootPath: string
  files: PortableFile[]
  directories: Array<{ path: string }>
  compatibility: CompatibilityReport
  /**
   * Raw contents of the project's `.env`, sent at the user's request so Web
   * seeds its per-project secret store (same treatment as Web-created
   * projects). Never included in `files` — Web keeps env out of the VFS.
   */
  env?: string
  metadata: Record<string, unknown>
}

interface ExportResponse {
  importId: string
  importToken?: string
  webUrl: string
  expiresInSeconds: number
}

export interface WebExportSummary {
  fileCount: number
  directoryCount: number
  totalBytes: number
  assetCount: number
  skippedGenerated: number
  skippedHidden: number
  skippedSensitive: number
  skippedUnsupported: number
}

export interface PreparedWebExport {
  payload: ExportPackage
  summary: WebExportSummary
}

export interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
}

const EXCLUDED_DIRS = new Set([
  '.git',
  '.agents',
  '.codex',
  '.firebase',
  '.idea',
  '.netlify',
  '.serverless',
  '.sst',
  '.tms',
  '.toquemedia',
  '.turbo',
  '.vercel',
  '.vite',
  '.vscode',
  '.wrangler',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
])

const TEXT_EXTENSIONS = new Set([
  'cjs', 'css', 'csv', 'html', 'js', 'json', 'jsx', 'lock', 'md', 'mjs', 'sql',
  'svg', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml',
])

const TEXT_FILENAMES = new Set([
  '.dockerignore',
  '.env.example',
  '.gitignore',
  '.npmrc.example',
  'Dockerfile',
  'LICENSE',
  'README',
  'TMS.md',
])

// Binary assets travel base64-encoded so images/fonts/media keep working on
// Web (they end up in the deploy source bundle on R2 and are served by the
// published site). Bounded so a stray video folder can't blow up the import.
const ASSET_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'mp4', 'webm', 'pdf',
])
const MAX_ASSET_FILE_BYTES = 5 * 1024 * 1024
const MAX_ASSET_TOTAL_BYTES = 12 * 1024 * 1024

function isAssetFile(path: string): boolean {
  const filename = path.split('/').pop() || ''
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : ''
  return Boolean(ext && ASSET_EXTENSIONS.has(ext))
}

/**
 * Async base64 via FileReader — the previous char-by-char loop ran on the
 * main thread and froze the UI (activity spinner included) for seconds on
 * multi-MB assets.
 */
function bytesToBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('base64 encode failed'))
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '')
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
    }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    reader.readAsDataURL(new Blob([buffer]))
  })
}

/** Devolve o controlo ao event loop — mantém a UI viva em loops longos. */
function yieldToUi(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

type SkipReason = 'generated' | 'hidden' | 'sensitive' | 'unsupported'

interface CollectStats {
  skippedGenerated: number
  skippedHidden: number
  skippedSensitive: number
  skippedUnsupported: number
}

const EMPTY_COLLECT_STATS = (): CollectStats => ({
  skippedGenerated: 0,
  skippedHidden: 0,
  skippedSensitive: 0,
  skippedUnsupported: 0,
})

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean).join('/')
}

function relativePath(rootPath: string, absolutePath: string): string {
  const root = normalize(rootPath)
  const current = normalize(absolutePath)
  return current === root ? '' : current.startsWith(`${root}/`) ? current.slice(root.length + 1) : current
}

function isSecretLikePath(path: string): boolean {
  const filename = (path.split('/').pop() || '').toLowerCase()
  return (
    filename === '.npmrc' ||
    filename === '.netrc' ||
    (filename.startsWith('.env') && filename !== '.env.example') ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i.test(filename) ||
    /\.pem$/i.test(filename) ||
    /\.key$/i.test(filename) ||
    /\.p12$/i.test(filename) ||
    /\.pfx$/i.test(filename) ||
    /credentials?\.json$/i.test(filename) ||
    /service[-_]?account.*\.json$/i.test(filename) ||
    /(^|[._-])(secret|secrets|token|tokens|credential|credentials|private[-_]?key)([._-]|$)/i.test(filename) ||
    /_secret/i.test(filename)
  )
}

function classifyPortableExportPath(path: string, options: { isDirectory?: boolean } = {}): SkipReason | null {
  const parts = normalize(path).split('/')
  if (parts.some(part => EXCLUDED_DIRS.has(part))) return 'generated'
  if (isSecretLikePath(path)) return 'sensitive'

  const filename = parts[parts.length - 1] || ''
  // PLAN.md é rascunho de trabalho do agente — nunca acompanha o projeto
  // (pedido explícito do developer, 2026-07-08).
  if (filename.toLowerCase() === 'plan.md') return 'generated'
  const parentParts = parts.slice(0, -1)
  if (parentParts.some(part => part.startsWith('.'))) return 'hidden'
  if (filename.startsWith('.') && !TEXT_FILENAMES.has(filename)) return 'hidden'

  if (!options.isDirectory && filename && !isTextFile(path) && !isAssetFile(path)) return 'unsupported'
  return null
}

export function shouldSkipPortableExportPath(path: string, options: { isDirectory?: boolean } = {}): boolean {
  return classifyPortableExportPath(path, options) !== null
}

function isTextFile(path: string): boolean {
  const filename = path.split('/').pop() || ''
  if (TEXT_FILENAMES.has(filename)) return true
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : ''
  return Boolean(ext && TEXT_EXTENSIONS.has(ext))
}

function bumpSkip(stats: CollectStats, reason: SkipReason): void {
  if (reason === 'generated') stats.skippedGenerated += 1
  else if (reason === 'hidden') stats.skippedHidden += 1
  else if (reason === 'sensitive') stats.skippedSensitive += 1
  else stats.skippedUnsupported += 1
}

function collectNodes(
  rootPath: string,
  node: FileTreeNode,
  files: FileTreeNode[],
  directories: string[],
  stats: CollectStats,
): void {
  const rel = relativePath(rootPath, node.path)
  const isDirectory = node.type === 'directory'
  const skip = rel ? classifyPortableExportPath(rel, { isDirectory }) : null
  if (skip) {
    bumpSkip(stats, skip)
    return
  }

  if (isDirectory) {
    if (rel) directories.push(rel)
    for (const child of node.children ?? []) collectNodes(rootPath, child, files, directories, stats)
    return
  }

  if (!rel) return
  files.push(node)
}

function parsePackageJson(files: PortableFile[]): PackageJson | undefined {
  const file = files.find(item => item.path === 'package.json')
  if (!file) return undefined
  try {
    return JSON.parse(file.content) as PackageJson
  } catch {
    return undefined
  }
}

function allDeps(pkg: PackageJson): Set<string> {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ])
}

// Mirrors the Web side (webAgent/compatibility.ts): a backend is either a
// server|backend/ folder with its own package.json, or the TM scaffold
// single-package layout — an entrypoint in server/ with the server-framework
// dependency living in the ROOT package.json (fila1-style projects).
const BACKEND_DIR_CANDIDATES = ['server', 'backend']
const SERVER_FRAMEWORK_DEPS = ['express', 'fastify', 'hono', '@hono/node-server', 'koa', '@nestjs/core']
const BACKEND_ENTRY_SUFFIXES = ['index.ts', 'index.js', 'index.mjs', 'index.cjs', 'src/index.ts', 'src/index.js']

export function detectBackendDir(paths: Set<string>, pkg?: PackageJson): string | undefined {
  for (const dir of BACKEND_DIR_CANDIDATES) {
    if (paths.has(`${dir}/package.json`)) return dir
  }
  if (!pkg) return undefined
  const deps = allDeps(pkg)
  if (!SERVER_FRAMEWORK_DEPS.some(dep => deps.has(dep))) return undefined
  for (const dir of BACKEND_DIR_CANDIDATES) {
    if (BACKEND_ENTRY_SUFFIXES.some(entry => paths.has(`${dir}/${entry}`))) return dir
  }
  return undefined
}

export function detectDatabase(files: PortableFile[], pkg?: PackageJson): boolean {
  const deps = pkg ? allDeps(pkg) : new Set<string>()
  if (['drizzle-orm', '@libsql/client', 'better-sqlite3', 'sqlite3'].some(dep => deps.has(dep))) return true
  return files.some(file => {
    if (file.encoding === 'base64') return false
    if (/(?:^|\/)schema\.(?:ts|js)$/i.test(file.path) && /\bsqliteTable\s*\(/.test(file.content)) return true
    if (/\.sql$/i.test(file.path) && /(?:^|\/)(?:drizzle|migrations?|db|database)(?:\/|$)/i.test(file.path)) return true
    return false
  })
}

export function detectFramework(files: PortableFile[], pkg?: PackageJson): Framework {
  const paths = new Set(files.map(file => file.path))
  const deps = pkg ? allDeps(pkg) : new Set<string>()
  if (deps.has('next')) return 'nextjs'
  if (deps.has('vite') && deps.has('react')) {
    return detectBackendDir(paths, pkg) ? 'react-vite-fullstack' : 'react-vite'
  }
  if (deps.has('vite')) return 'vanilla-vite'
  if (paths.has('index.html')) return 'static-html'
  return pkg ? 'unsupported' : 'unknown'
}

function detectPackageManager(files: PortableFile[], pkg?: PackageJson): CompatibilityReport['packageManager'] {
  if (files.some(file => file.path === 'bun.lockb')) return 'bun'
  if (files.some(file => file.path === 'pnpm-lock.yaml')) return 'pnpm'
  if (files.some(file => file.path === 'yarn.lock')) return 'yarn'
  if (files.some(file => file.path === 'package-lock.json')) return 'npm'
  const declared = pkg?.packageManager?.split('@')[0]
  if (declared === 'bun' || declared === 'pnpm' || declared === 'yarn' || declared === 'npm') return declared
  return undefined
}

function analyze(files: PortableFile[]): CompatibilityReport {
  const pkg = parsePackageJson(files)
  const framework = files.length === 0 ? 'unsupported' : detectFramework(files, pkg)
  const capabilities: Capability[] = files.length > 0 ? ['edit'] : []
  const warnings: string[] = []
  const blockers: string[] = []
  const hasBuild = Boolean(pkg?.scripts?.build)

  if (files.length === 0) blockers.push('No portable text files were found.')
  if (files.some(file => file.path === 'package.json') && !pkg) blockers.push('package.json is not valid JSON.')

  const paths = new Set(files.map(file => file.path))
  const backendDir = detectBackendDir(paths, pkg)
  const hasDatabase = detectDatabase(files, pkg)

  if (framework === 'react-vite' || framework === 'react-vite-fullstack') {
    capabilities.push('preview')
    if (hasBuild) capabilities.push('check', 'deploy')
    if (framework === 'react-vite-fullstack') {
      warnings.push(
        `Backend detected in "${backendDir}/": it runs in Web's remote preview and deploy. ` +
        '.env files are never exported — configure the project env vars in Web before testing.',
      )
    }
  } else if (framework === 'nextjs') {
    if (hasBuild) capabilities.push('check', 'deploy')
    warnings.push('NextJS opens in Web for check/deploy; browser preview is limited.')
  } else if (framework === 'static-html') {
    capabilities.push('preview')
  } else if (framework === 'vanilla-vite') {
    capabilities.push('preview')
    if (hasBuild) capabilities.push('check')
    warnings.push('Deploy currently supports React + Vite and NextJS only.')
  } else {
    warnings.push('No supported Web runtime was detected; Web will import it for editing only.')
  }

  if (hasDatabase) {
    warnings.push(
      'Database detected: the managed database is provisioned before sending, the structure (migrations) is applied ' +
      'and the existing local data is copied into it. Local .db files themselves are not exported.',
    )
  }

  return {
    importable: blockers.length === 0,
    framework,
    capabilities,
    entryRoot: '.',
    packageManager: detectPackageManager(files, pkg),
    ...(backendDir ? { backendDir } : {}),
    hasDatabase,
    blockers,
    warnings,
  }
}

async function buildPackage(projectPath: string, projectName: string): Promise<PreparedWebExport> {
  const tree = await FileTreeService.buildFileTree(projectPath, {
    showHidden: true,
    respectGitignore: true,
  })
  const fileNodes: FileTreeNode[] = []
  const directories: string[] = []
  const stats = EMPTY_COLLECT_STATS()
  collectNodes(projectPath, tree, fileNodes, directories, stats)

  const files: PortableFile[] = []
  const textEncoder = new TextEncoder()
  let totalBytes = 0
  let assetCount = 0
  let assetBytes = 0
  let processed = 0
  for (const node of fileNodes) {
    // Respirar a cada lote de ficheiros: sem isto o loop monopoliza o main
    // thread e o painel de atividade parece congelado.
    processed += 1
    if (processed % 25 === 0) await yieldToUi()

    const rel = relativePath(projectPath, node.path)
    if (isAssetFile(rel) && !isTextFile(rel)) {
      try {
        const { readFile: tauriReadFile } = await import('@tauri-apps/plugin-fs')
        const bytes = await tauriReadFile(node.path)
        if (bytes.length > MAX_ASSET_FILE_BYTES || assetBytes + bytes.length > MAX_ASSET_TOTAL_BYTES) {
          stats.skippedUnsupported += 1
          continue
        }
        files.push({ path: rel, content: await bytesToBase64(bytes), encoding: 'base64' })
        assetCount += 1
        assetBytes += bytes.length
        totalBytes += bytes.length
      } catch {
        stats.skippedUnsupported += 1
      }
      continue
    }
    try {
      const content = await FileService.readFile(node.path)
      files.push({ path: rel, content })
      totalBytes += textEncoder.encode(content).length
    } catch {
      stats.skippedUnsupported += 1
      // Too-large or unreadable files are intentionally omitted.
    }
  }

  const uniqueDirectories = [...new Set(directories)].map(path => ({ path }))
  const payload: ExportPackage = {
    schemaVersion: 1,
    source: 'tm-code-ide',
    exportedAt: new Date().toISOString(),
    projectName,
    rootPath: '.',
    files,
    directories: uniqueDirectories,
    compatibility: analyze(files),
    metadata: {
      ide: 'tm-code',
      exportKind: 'direct-web-import',
    },
  }

  return {
    payload,
    summary: {
      fileCount: files.length,
      directoryCount: uniqueDirectories.length,
      totalBytes,
      assetCount,
      ...stats,
    },
  }
}

export async function prepareProjectWebExport(project: { name: string; path: string }): Promise<PreparedWebExport> {
  return buildPackage(project.path, project.name)
}

/**
 * Apply SQL statements via the migrate endpoint, RESUMING past tolerated
 * failures. The endpoint executes sequentially and stops at the first error —
 * on a database with residue from previous exports the early statements fail
 * with idempotent noise ("already exists", seed rows hitting UNIQUE), and
 * without resuming, everything after the first noisy statement was silently
 * skipped. Any non-tolerated failure aborts the export.
 */
async function applyStatementsResumable(
  projectId: string,
  token: string,
  statements: string[],
  tolerated: RegExp,
  context: string,
): Promise<void> {
  const CHUNK = 400
  let index = 0
  while (index < statements.length) {
    const chunk = statements.slice(index, index + CHUNK)
    const response = await tauriFetch(
      `${resolveWorkerUrl()}/v1/apps/${encodeURIComponent(projectId)}/database/migrate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ statements: chunk }),
        timeoutSecs: 120,
      },
    )
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`${context} failed (HTTP ${response.status}): ${body.slice(0, 200)}. Export aborted — nothing was sent.`)
    }
    const data = await response.json().catch(() => ({})) as {
      applied?: number
      failed?: { index?: number; error?: string }
    }
    if (!data.failed) {
      index += chunk.length
      continue
    }
    const failedAt = index + (data.failed.index ?? 0)
    const failureText = String(data.failed.error ?? '')
    if (!tolerated.test(failureText)) {
      throw new Error(`${context} failed at statement ${failedAt + 1}: ${failureText.slice(0, 200)}. Export aborted — nothing was sent.`)
    }
    // Ruído idempotente — retoma a partir do statement seguinte.
    index = failedAt + 1
  }
}

/**
 * Provision the project's managed database (Turso via TMDB proxy) BEFORE the
 * project lands on Web. The endpoint is idempotent — an already-provisioned
 * app just returns its existing credentials. TMDB_URL/TMDB_TOKEN are written
 * to the local .env (same behaviour as the explicit `provision_database`
 * tool), so the exported env points the app at the managed DB instead of the
 * local .db file, and Web deploys reuse the SAME database via the app id.
 */
async function provisionDatabaseForExport(
  project: { id: string; path: string },
  token: string,
  migrationStatements: string[],
  onProgress?: (progress: WebExportProgress) => void,
): Promise<{ dbName: string; reused: boolean }> {
  const response = await tauriFetch(
    `${resolveWorkerUrl()}/v1/apps/${encodeURIComponent(project.id)}/database/provision`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
      timeoutSecs: 45,
    },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Database provisioning failed (HTTP ${response.status}): ${body.slice(0, 200)}`)
  }
  const data = await response.json() as { tmdbUrl?: string; tmdbToken?: string; dbName?: string; reused?: boolean }
  if (!data.tmdbUrl || !data.tmdbToken || !data.dbName) {
    throw new Error(`Database provisioning returned incomplete data: ${JSON.stringify(data)}`)
  }

  // Apply the project's migrations to the MANAGED database right away, so it
  // has tables before the project lands on Web. The migrate endpoint STOPS at
  // the first failing statement — on a database with residue from previous
  // exports/tests the early statements legitimately fail ("already exists",
  // seed rows hitting UNIQUE), so we RESUME from the next statement instead
  // of silently dropping the rest (or aborting on idempotent noise).
  if (migrationStatements.length > 0) {
    await applyStatementsResumable(
      project.id,
      token,
      migrationStatements,
      /already exists|duplicate column|UNIQUE constraint|PRIMARY KEY constraint/i,
      'Applying migrations to the managed database',
    )
    onProgress?.({ phase: 'db-migrated', statements: migrationStatements.length })

    // DATA migration: the rows the developer already has in the local .db
    // travel to the managed database too. INSERT OR IGNORE + tolerated
    // constraint classes keep re-exports idempotent; the dump orders tables
    // parents-first so FK-enforced databases accept them.
    onProgress?.({ phase: 'db-data-start' })
    const dump = await dumpLocalDatabaseData(project.path)
    if (dump && dump.statements.length > 0) {
      await applyStatementsResumable(
        project.id,
        token,
        dump.statements,
        /UNIQUE constraint|PRIMARY KEY constraint/i,
        'Copying local data to the managed database',
      )
      onProgress?.({ phase: 'db-data', rows: dump.rows })
    } else {
      onProgress?.({ phase: 'db-data', rows: 0 })
    }
  }

  // Positive proof of life, not just a 200 from the provision endpoint: ask
  // the database for its TABLES through the returned URL + token. This
  // catches stale records, bad tokens, unreachable proxies AND an empty
  // schema — any failure ABORTS the export (user requirement: no send
  // without a positive confirmation of every step).
  const probe = await tauriFetch(data.tmdbUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.tmdbToken}`,
    },
    body: JSON.stringify({
      sql: "SELECT count(*) FROM sqlite_master WHERE type = 'table'",
      params: [],
      method: 'get',
    }),
    timeoutSecs: 30,
  })
  if (!probe.ok) {
    const body = await probe.text().catch(() => '')
    throw new Error(
      `Database verification failed (HTTP ${probe.status}): the provisioned database did not answer a test query. ` +
      `Export aborted — nothing was sent. ${body.slice(0, 200)}`,
    )
  }
  if (migrationStatements.length > 0) {
    const probeData = await probe.json().catch(() => null) as { rows?: unknown[][] } | null
    const tableCount = Number(probeData?.rows?.[0]?.[0] ?? 0)
    if (!Number.isFinite(tableCount) || tableCount <= 0) {
      throw new Error(
        'The managed database answered but has no tables after applying migrations. Export aborted — nothing was sent.',
      )
    }
  }

  await invoke('write_env_vars', {
    projectPath: project.path,
    vars: [
      { key: 'TMDB_URL', value: data.tmdbUrl },
      { key: 'TMDB_TOKEN', value: data.tmdbToken },
    ],
  })
  return { dbName: data.dbName, reused: data.reused === true }
}

export type WebExportProgress =
  | { phase: 'provision-db' }
  | { phase: 'db-ready'; dbName: string; reused: boolean }
  | { phase: 'db-migrated'; statements: number }
  | { phase: 'db-data-start' }
  | { phase: 'db-data'; rows: number }
  | { phase: 'db-verified' }
  | { phase: 'db-linked' }
  | { phase: 'uploading'; envVarCount: number }

// ── Migração de DADOS do .db local para a base gerida ────────────────────
//
// Script executado DENTRO do projeto (cwd = raiz) com o Node do developer:
// encontra o ficheiro SQLite local, abre-o com o @libsql/client do próprio
// projeto (contrato dos scaffolds TM; fallback better-sqlite3) e imprime um
// JSON com INSERT OR IGNORE idempotentes — re-exportar não duplica registos.
// A tabela de bookkeeping do drizzle fica de fora.
const DB_DATA_DUMP_SCRIPT = `
import fs from 'node:fs'
import path from 'node:path'

const MAX_SQL_BYTES = 8 * 1024 * 1024

const candidates = []
for (const dir of ['.', 'server', 'backend', 'data']) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/\\.(db|sqlite3?|db3)$/i.test(name)) candidates.push(dir === '.' ? name : path.join(dir, name))
    }
  } catch {}
}
const dbFile = candidates[0] ?? null
if (!dbFile) {
  console.log(JSON.stringify({ dbFile: null, rows: 0, statements: [] }))
  process.exit(0)
}

async function openDb() {
  try {
    const { createClient } = await import('@libsql/client')
    const client = createClient({ url: 'file:' + dbFile.split(path.sep).join('/') })
    return {
      query: async (sql) => {
        const result = await client.execute(sql)
        return { columns: result.columns, rows: result.rows }
      },
      close: () => client.close(),
    }
  } catch {}
  const better = (await import('better-sqlite3')).default
  const database = new better(dbFile, { readonly: true })
  return {
    query: async (sql) => {
      const rows = database.prepare(sql).all()
      return { columns: rows.length > 0 ? Object.keys(rows[0]) : [], rows }
    },
    close: () => database.close(),
  }
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return "X'" + Buffer.from(value).toString('hex') + "'"
  }
  return "'" + String(value).replace(/'/g, "''") + "'"
}

const db = await openDb()
try {
  const tables = (await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
  )).rows.map(row => Array.isArray(row) ? row[0] : row.name)

  // Ordenar pais-primeiro pelas foreign keys: se a base de destino tiver a
  // verificação de FK ativa, inserir um filho antes do pai daria erro de
  // constraint. Ciclos ou falha do PRAGMA caem na ordem original.
  const dependsOn = new Map()
  for (const table of tables) {
    try {
      const fks = await db.query('PRAGMA foreign_key_list("' + String(table).replace(/"/g, '""') + '")')
      const parents = fks.rows
        .map(row => Array.isArray(row) ? row[2] : row.table)
        .filter(parent => parent && parent !== table && tables.includes(parent))
      dependsOn.set(table, new Set(parents))
    } catch {
      dependsOn.set(table, new Set())
    }
  }
  const ordered = []
  const placed = new Set()
  let progressed = true
  while (progressed && ordered.length < tables.length) {
    progressed = false
    for (const table of tables) {
      if (placed.has(table)) continue
      const parents = dependsOn.get(table) ?? new Set()
      if ([...parents].every(parent => placed.has(parent))) {
        ordered.push(table)
        placed.add(table)
        progressed = true
      }
    }
  }
  for (const table of tables) if (!placed.has(table)) ordered.push(table)

  const statements = []
  let totalRows = 0
  let totalBytes = 0
  for (const table of ordered) {
    const result = await db.query('SELECT * FROM "' + String(table).replace(/"/g, '""') + '"')
    if (result.rows.length === 0) continue
    const columns = result.columns
    const columnSql = columns.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(', ')
    for (const row of result.rows) {
      const values = columns.map((col, index) => sqlValue(Array.isArray(row) ? row[index] : row[col])).join(', ')
      const statement = 'INSERT OR IGNORE INTO "' + String(table).replace(/"/g, '""') + '" (' + columnSql + ') VALUES (' + values + ')'
      totalBytes += statement.length
      if (totalBytes > MAX_SQL_BYTES) {
        console.log(JSON.stringify({ dbFile, error: 'too-large', rows: totalRows }))
        process.exit(0)
      }
      statements.push(statement)
      totalRows += 1
    }
  }
  console.log(JSON.stringify({ dbFile, rows: totalRows, statements }))
} finally {
  try { db.close() } catch {}
}
`

const DB_DUMP_SCRIPT_PATH = '.toquemedia/tm-export-db-dump.mjs'

interface LocalDatabaseDump {
  dbFile: string
  rows: number
  statements: string[]
}

/**
 * Dump the local SQLite data as idempotent INSERT statements, using the
 * project's own runtime (Node + @libsql/client from its node_modules).
 * Returns null when the project has no local database file.
 */
async function dumpLocalDatabaseData(projectPath: string): Promise<LocalDatabaseDump | null> {
  await invoke('write_file', { path: `${projectPath}/${DB_DUMP_SCRIPT_PATH}`, content: DB_DATA_DUMP_SCRIPT })
  try {
    const result = await invoke<{ stdout: string; stderr: string; success: boolean; exitCode: number }>(
      'execute_command',
      { command: `node "${DB_DUMP_SCRIPT_PATH}"`, cwd: projectPath, timeoutSecs: 90 },
    )
    if (!result.success) {
      throw new Error(
        `Reading the local database data failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}. ` +
        'Export aborted — nothing was sent. Run "npm install" in the project and retry.',
      )
    }
    const jsonLine = result.stdout.trim().split('\n').pop() ?? ''
    let parsed: { dbFile: string | null; rows?: number; statements?: string[]; error?: string }
    try {
      parsed = JSON.parse(jsonLine)
    } catch {
      throw new Error(`Reading the local database data returned unexpected output: ${jsonLine.slice(0, 200)}`)
    }
    if (!parsed.dbFile) return null
    if (parsed.error === 'too-large') {
      throw new Error(
        `The local database (${parsed.dbFile}) has too much data to migrate automatically (limit 8MB of SQL). Export aborted.`,
      )
    }
    return { dbFile: parsed.dbFile, rows: parsed.rows ?? 0, statements: parsed.statements ?? [] }
  } finally {
    try { await FileService.deleteFile(`${projectPath}/${DB_DUMP_SCRIPT_PATH}`) } catch { /* best-effort cleanup */ }
  }
}

/** Drizzle migration .sql files → individual statements for the migrate endpoint. */
function collectMigrationStatements(files: PortableFile[]): string[] {
  const sqlFiles = files
    .filter(file => file.encoding !== 'base64')
    .filter(file => /\.sql$/i.test(file.path))
    .filter(file => /(?:^|\/)(?:drizzle|migrations?|db|database)(?:\/|$)/i.test(file.path))
    .sort((a, b) => a.path.localeCompare(b.path))
  const statements: string[] = []
  for (const file of sqlFiles) {
    for (const raw of file.content.split(/-->\s*statement-breakpoint/gi)) {
      const statement = raw.trim().replace(/;\s*$/, '')
      if (statement) statements.push(statement)
    }
  }
  return statements
}

// Canonical managed-only db.ts — mirrors the production branch of the TM
// scaffold (drizzle sqlite-proxy over the platform's TMDB endpoint), with the
// local-file branch removed entirely. Written into the EXPORTED copy so the
// Web agent and the preview/publish runtimes only ever see the managed DB —
// no dev.db traces, nothing writing to a throwaway local file.
const MANAGED_DB_FILE = `// Gerado pelo TM Code ao enviar para a Web.
// Esta app usa EXCLUSIVAMENTE a base de dados gerida da plataforma (via
// proxy HTTP TMDB). Não existe fallback para ficheiros .db locais — em
// qualquer ambiente (preview, publicação), TMDB_URL e TMDB_TOKEN vêm das
// configurações do projeto.
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.js';

const tmdbUrl = process.env.TMDB_URL;
const tmdbToken = process.env.TMDB_TOKEN;

if (!tmdbUrl || !tmdbToken) {
  throw new Error('TMDB_URL e TMDB_TOKEN têm de estar configuradas — esta app usa apenas a base de dados gerida.');
}

async function callTmdb(path: string, body: unknown): Promise<any> {
  const response = await fetch(\`\${tmdbUrl}\${path}\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${tmdbToken}\`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(\`Erro no proxy da base de dados: \${response.status} - \${errorText}\`);
  }

  return response.json();
}

let db: any;

db = drizzle(
  async (sql: string, params: any[], method: string) => {
    const result = (await callTmdb('', { sql, params, method })) as { rows: any[][] };
    return { rows: result.rows };
  },
  // Transações (db.transaction / db.batch): lote atómico no endpoint /batch,
  // que devolve um array de { rows } pela mesma ordem das queries.
  async (queries: { sql: string; params: any[]; method: string }[]) => {
    const results = (await callTmdb('/batch', {
      queries: queries.map((q) => ({ sql: q.sql, params: q.params, method: q.method })),
    })) as { rows: any[][] }[];
    return results;
  },
  { schema }
);

export { db };
export { schema };
`

/**
 * Point the exported copy's db.ts at the managed database ONLY. Applies just
 * to the TM scaffold contract (a {server|backend}/db.ts that already has the
 * TMDB production branch plus a local-file dev branch) — anything else is
 * left untouched and reported via a compatibility warning.
 */
function rewriteDbFileToManaged(payload: ExportPackage): { rewritten: boolean; path?: string } {
  const backendDir = payload.compatibility.backendDir
  if (!backendDir) return { rewritten: false }
  const dbFile = payload.files.find(file => file.path === `${backendDir}/db.ts` || file.path === `${backendDir}/db.js`)
  if (!dbFile) return { rewritten: false }
  const matchesContract = dbFile.content.includes('TMDB_URL')
    && (dbFile.content.includes('dev.db') || dbFile.content.includes('DATABASE_URL'))
  if (!matchesContract) {
    payload.compatibility.warnings.push(
      `Could not automatically point "${dbFile.path}" at the managed database — it does not follow the standard contract. Review it on Web.`,
    )
    return { rewritten: false }
  }
  dbFile.content = MANAGED_DB_FILE
  return { rewritten: true, path: dbFile.path }
}

export async function sendProjectToTmCodeWeb(
  project: { id?: string; name: string; path: string },
  prepared?: PreparedWebExport,
  onProgress?: (progress: WebExportProgress) => void,
): Promise<ExportResponse> {
  const token = await FirebaseAuthService.getInstance().getIdToken(true)
  if (!token) throw new Error('Not signed in to TM Code. Sign in and retry.')

  const { payload } = prepared ?? await prepareProjectWebExport(project)
  if (!payload.compatibility.importable) {
    throw new Error(payload.compatibility.blockers.join(' ') || 'Project is not importable.')
  }

  // DB-first: a project that uses a database must have its managed DB
  // provisioned BEFORE it lands on Web — blocking on purpose (user decision):
  // exporting an app that still points at file:./dev.db just ships a broken
  // backend. Provisioning also rewrites .env to point at the managed DB.
  if (payload.compatibility.hasDatabase) {
    // No silent skip: a database project without an app identity cannot be
    // provisioned, so it must not be exported at all.
    if (!project.id) {
      throw new Error('This project uses a database but has no app identity — export aborted. Reopen the project and retry.')
    }
    onProgress?.({ phase: 'provision-db' })
    const migrationStatements = collectMigrationStatements(payload.files)
    const provisioned = await provisionDatabaseForExport(
      { id: project.id, path: project.path },
      token,
      migrationStatements,
      onProgress,
    )
    payload.metadata.database = { provisioned: true, dbName: provisioned.dbName, reused: provisioned.reused }
    onProgress?.({ phase: 'db-ready', dbName: provisioned.dbName, reused: provisioned.reused })
    onProgress?.({ phase: 'db-verified' })

    // The EXPORTED copy points at the managed database only — the local-file
    // branch is removed so the Web agent, preview and publish never touch a
    // throwaway .db again (user requirement: no trace of local DB usage).
    const linked = rewriteDbFileToManaged(payload)
    if (linked.rewritten) {
      payload.metadata.databaseLinked = { path: linked.path }
      onProgress?.({ phase: 'db-linked' })
    }
  }

  // App identity travels with the export: Web deploys use this id against the
  // control-plane so the deploy record, slug and provisioned database are the
  // SAME app the IDE worked on (container/deploy injects TMDB_* from the KV
  // record keyed by this id — caller-supplied TMDB vars are stripped).
  if (project.id) payload.metadata.appId = project.id

  // .env travels OUTSIDE the file list, to be seeded into Web's per-project
  // secret store (exactly how Web-created projects manage env). Read AFTER
  // provisioning so TMDB_URL/TMDB_TOKEN are already in it.
  try {
    const envContent = await FileService.readFile(`${project.path}/.env`)
    if (envContent.trim()) payload.env = envContent
  } catch { /* no .env — nothing to send */ }

  const envVarCount = (payload.env ?? '')
    .split('\n')
    .filter(line => /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .length
  onProgress?.({ phase: 'uploading', envVarCount })

  const response = await tauriFetch(`${resolveWorkerUrl()}/v1/web-agent/imports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(IS_VITE_DEV ? { 'TM-Code': 'dev-deploy' } : {}),
    },
    body: JSON.stringify(payload),
    timeoutSecs: 60,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let parsed: { error?: string } = {}
    try {
      parsed = JSON.parse(text) as { error?: string }
    } catch {
      // Not JSON.
    }
    throw new Error(parsed.error || text || `TM Code Web import failed (${response.status}).`)
  }

  const result = await response.json() as ExportResponse
  return {
    ...result,
    webUrl: buildTmCodeWebImportUrl(result.importId, undefined, { importToken: result.importToken }),
  }
}
