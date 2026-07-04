import { FileTreeService } from './fileTreeService'
import { FileService } from './fileService'
import FirebaseAuthService from './auth/firebaseAuth'
import { tauriFetch } from './tauriFetch'
import { buildTmCodeWebImportUrl, resolveWorkerUrl } from '@/utils/devUrls'
import { IS_VITE_DEV } from '@/utils/viteEnv'
import type { FileTreeNode } from '../types/fileTree'

type Capability = 'edit' | 'preview' | 'check' | 'deploy'
type Framework = 'react-vite' | 'nextjs' | 'static-html' | 'vanilla-vite' | 'unsupported' | 'unknown'

interface PortableFile {
  path: string
  content: string
}

interface CompatibilityReport {
  importable: boolean
  framework: Framework
  capabilities: Capability[]
  entryRoot: string
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun'
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
  skippedGenerated: number
  skippedHidden: number
  skippedSensitive: number
  skippedUnsupported: number
}

export interface PreparedWebExport {
  payload: ExportPackage
  summary: WebExportSummary
}

interface PackageJson {
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
  const parentParts = parts.slice(0, -1)
  if (parentParts.some(part => part.startsWith('.'))) return 'hidden'
  if (filename.startsWith('.') && !TEXT_FILENAMES.has(filename)) return 'hidden'

  if (!options.isDirectory && filename && !isTextFile(path)) return 'unsupported'
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

function detectFramework(files: PortableFile[], pkg?: PackageJson): Framework {
  const paths = new Set(files.map(file => file.path))
  const deps = pkg ? allDeps(pkg) : new Set<string>()
  if (deps.has('next')) return 'nextjs'
  if (deps.has('vite') && deps.has('react')) return 'react-vite'
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

  if (framework === 'react-vite') {
    capabilities.push('preview')
    if (hasBuild) capabilities.push('check', 'deploy')
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

  return {
    importable: blockers.length === 0,
    framework,
    capabilities,
    entryRoot: '.',
    packageManager: detectPackageManager(files, pkg),
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
  let totalBytes = 0
  for (const node of fileNodes) {
    const rel = relativePath(projectPath, node.path)
    try {
      const content = await FileService.readFile(node.path)
      files.push({ path: rel, content })
      totalBytes += new TextEncoder().encode(content).length
    } catch {
      stats.skippedUnsupported += 1
      // Binary, too-large, or unreadable files are intentionally omitted.
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
      ...stats,
    },
  }
}

export async function prepareProjectWebExport(project: { name: string; path: string }): Promise<PreparedWebExport> {
  return buildPackage(project.path, project.name)
}

export async function sendProjectToTmCodeWeb(
  project: { name: string; path: string },
  prepared?: PreparedWebExport,
): Promise<ExportResponse> {
  const token = await FirebaseAuthService.getInstance().getIdToken(true)
  if (!token) throw new Error('Not signed in to TM Code. Sign in and retry.')

  const { payload } = prepared ?? await prepareProjectWebExport(project)
  if (!payload.compatibility.importable) {
    throw new Error(payload.compatibility.blockers.join(' ') || 'Project is not importable.')
  }

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
