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
  webUrl: string
  expiresInSeconds: number
}

interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
}

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.vite',
  '.turbo',
  'coverage',
])

const TEXT_EXTENSIONS = new Set([
  'cjs', 'css', 'csv', 'env', 'html', 'js', 'json', 'jsx', 'lock', 'md', 'mjs', 'sql',
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

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean).join('/')
}

function relativePath(rootPath: string, absolutePath: string): string {
  const root = normalize(rootPath)
  const current = normalize(absolutePath)
  return current === root ? '' : current.startsWith(`${root}/`) ? current.slice(root.length + 1) : current
}

function isSecretLikePath(path: string): boolean {
  const filename = path.split('/').pop() || ''
  return (
    filename === '.npmrc' ||
    (filename.startsWith('.env') && filename !== '.env.example') ||
    /\.pem$/i.test(filename) ||
    /\.key$/i.test(filename) ||
    /credentials\.json$/i.test(filename) ||
    /_secret/i.test(filename)
  )
}

function shouldSkipPath(path: string): boolean {
  const parts = normalize(path).split('/')
  if (parts.some(part => EXCLUDED_DIRS.has(part))) return true
  return isSecretLikePath(path)
}

function isTextFile(path: string): boolean {
  const filename = path.split('/').pop() || ''
  if (TEXT_FILENAMES.has(filename)) return true
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : ''
  return Boolean(ext && TEXT_EXTENSIONS.has(ext))
}

function collectNodes(rootPath: string, node: FileTreeNode, files: FileTreeNode[], directories: string[]): void {
  const rel = relativePath(rootPath, node.path)
  if (rel && shouldSkipPath(rel)) return

  if (node.type === 'directory') {
    if (rel) directories.push(rel)
    for (const child of node.children ?? []) collectNodes(rootPath, child, files, directories)
    return
  }

  if (!rel || shouldSkipPath(rel) || !isTextFile(rel)) return
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

async function buildPackage(projectPath: string, projectName: string): Promise<ExportPackage> {
  const tree = await FileTreeService.buildFileTree(projectPath, {
    showHidden: true,
    respectGitignore: true,
  })
  const fileNodes: FileTreeNode[] = []
  const directories: string[] = []
  collectNodes(projectPath, tree, fileNodes, directories)

  const files: PortableFile[] = []
  for (const node of fileNodes) {
    const rel = relativePath(projectPath, node.path)
    try {
      files.push({ path: rel, content: await FileService.readFile(node.path) })
    } catch {
      // Binary, too-large, or unreadable files are intentionally omitted.
    }
  }

  return {
    schemaVersion: 1,
    source: 'tm-code-ide',
    exportedAt: new Date().toISOString(),
    projectName,
    rootPath: '.',
    files,
    directories: [...new Set(directories)].map(path => ({ path })),
    compatibility: analyze(files),
    metadata: {
      ide: 'tm-code',
      exportKind: 'direct-web-import',
    },
  }
}

export async function sendProjectToTmCodeWeb(project: { name: string; path: string }): Promise<ExportResponse> {
  const token = await FirebaseAuthService.getInstance().getIdToken(true)
  if (!token) throw new Error('Not signed in to TM Code. Sign in and retry.')

  const payload = await buildPackage(project.path, project.name)
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
    webUrl: buildTmCodeWebImportUrl(result.importId),
  }
}
