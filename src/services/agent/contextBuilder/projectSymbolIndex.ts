import { invoke } from '@/utils/invokeMetrics'
import { cachedSafeReadFile } from '../ipcCache'
import { markProjectSymbolIndexRequested } from '../tmsContext'

export interface ProjectSymbolEntry {
  path: string
  line: number
  kind: string
  name: string
  summary: string
}

export interface ProjectSymbolIndex {
  entries: ProjectSymbolEntry[]
  filesConsidered: number
  filesScanned: number
  truncated: boolean
}

const SOURCE_PATTERNS = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.mjs',
  '**/*.cjs',
  '**/*.vue',
  '**/*.svelte',
  '**/*.rs',
  '**/*.go',
  '**/*.py',
  '**/*.php',
  '**/*.rb',
  '**/*.java',
  '**/*.kt',
  '**/*.swift',
  '**/*.cs',
]

const MAX_FILES_TO_SCAN = 60
const MAX_FILE_BYTES = 160 * 1024
const MAX_ENTRIES = 180
const MAX_ENTRIES_PER_FILE = 8

const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'target',
  'vendor',
  '__snapshots__',
])

const GENERATED_FILE_RE = /\.(d|generated|gen)\.[cm]?[tj]sx?$/i
const TEST_FILE_RE = /\.(test|spec|stories|story)\.[cm]?[tj]sx?$/i

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function toRelative(projectPath: string, absolutePath: string): string {
  const root = normalizePath(projectPath).replace(/\/$/, '')
  const normalized = normalizePath(absolutePath)
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
}

function extension(path: string): string {
  const name = normalizePath(path).split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

function isExcluded(path: string): boolean {
  const parts = normalizePath(path).split('/')
  return parts.some(part => EXCLUDED_SEGMENTS.has(part))
}

function pathScore(path: string): number {
  const rel = normalizePath(path)
  let score = 0
  if (rel.startsWith('src/')) score -= 20
  if (/\/(app|pages|routes|components|services|stores|hooks|utils|lib)\//.test(`/${rel}`)) score -= 10
  if (/\/(index|main|app|server|worker)\.[cm]?[tj]sx?$/i.test(`/${rel}`)) score -= 8
  if (TEST_FILE_RE.test(rel)) score += 30
  if (GENERATED_FILE_RE.test(rel)) score += 50
  return score
}

function uniqueSorted(paths: string[], projectPath: string): string[] {
  const root = normalizePath(projectPath).replace(/\/$/, '')
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    const normalized = normalizePath(path)
    if (!normalized.startsWith(`${root}/`)) continue
    if (isExcluded(normalized)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out.sort((a, b) => {
    const relA = toRelative(projectPath, a)
    const relB = toRelative(projectPath, b)
    const score = pathScore(relA) - pathScore(relB)
    return score || relA.localeCompare(relB)
  })
}

function cleanComment(line: string): string {
  return line
    .replace(/^\s*\/\*\*?/, '')
    .replace(/\*\/\s*$/, '')
    .replace(/^\s*\*\s?/, '')
    .replace(/^\s*\/\/\s?/, '')
    .replace(/^\s*#\s?/, '')
    .trim()
}

function nearbyComment(lines: string[], index: number): string | null {
  const comments: string[] = []
  for (let i = index - 1; i >= 0 && i >= index - 6; i--) {
    const raw = lines[i] ?? ''
    if (!raw.trim()) {
      if (comments.length > 0) break
      continue
    }
    if (/^\s*(\/\/|#|\*|\/\*)/.test(raw)) {
      const cleaned = cleanComment(raw)
      if (
        cleaned &&
        !/^[-=]{3,}$/.test(cleaned) &&
        !/^eslint|^ts-ignore|^@/.test(cleaned)
      ) {
        comments.unshift(cleaned)
      }
      continue
    }
    break
  }
  const joined = comments.join(' ').replace(/\s+/g, ' ').trim()
  return joined ? joined.slice(0, 140) : null
}

type SymbolPattern = {
  kind: string
  re: RegExp
  nameGroup?: number
}

function patternsForExt(ext: string): SymbolPattern[] {
  if (/^[cm]?[tj]sx?$/.test(ext) || ext === 'vue' || ext === 'svelte') {
    return [
      { kind: 'component/function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/ },
      { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/ },
      { kind: 'type', re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/ },
      { kind: 'component/constant', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*[:=]/ },
      { kind: 'hook/provider/handler', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([a-z][A-Za-z0-9_$]*(?:Hook|Store|Context|Provider|Handler|Service))\s*[:=]/ },
    ]
  }
  if (ext === 'rs') {
    return [
      { kind: 'function', re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/ },
      { kind: 'type', re: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)\b/ },
      { kind: 'impl', re: /^\s*impl(?:\s*<[^>]+>)?\s+([A-Za-z_][\w]*)\b/ },
    ]
  }
  if (ext === 'go') {
    return [
      { kind: 'function', re: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/ },
      { kind: 'type', re: /^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/ },
    ]
  }
  if (ext === 'py') {
    return [
      { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/ },
      { kind: 'class', re: /^\s*class\s+([A-Za-z_][\w]*)\b/ },
    ]
  }
  if (ext === 'php') {
    return [
      { kind: 'function', re: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_][\w]*)\s*\(/ },
      { kind: 'class', re: /^\s*(?:final\s+|abstract\s+)?class\s+([A-Za-z_][\w]*)\b/ },
    ]
  }
  if (ext === 'rb') {
    return [
      { kind: 'function', re: /^\s*def\s+([A-Za-z_][\w!?=]*)\b/ },
      { kind: 'class/module', re: /^\s*(?:class|module)\s+([A-Za-z_][\w:]*)\b/ },
    ]
  }
  if (['java', 'kt', 'swift', 'cs'].includes(ext)) {
    return [
      { kind: 'class/type', re: /^\s*(?:public|private|protected|internal|open|final|data|sealed|abstract|\s)*(?:class|interface|enum|struct|protocol)\s+([A-Za-z_][\w]*)\b/ },
      { kind: 'function', re: /^\s*(?:public|private|protected|internal|static|override|open|final|suspend|async|\s)*(?:fun|func|void|[A-Za-z_][\w<>, ?[\]]+)\s+([A-Za-z_][\w]*)\s*\(/ },
    ]
  }
  return []
}

export function extractProjectSymbolsFromContent(path: string, content: string): ProjectSymbolEntry[] {
  const ext = extension(path)
  const patterns = patternsForExt(ext)
  if (patterns.length === 0) return []

  const lines = content.split('\n')
  const entries: ProjectSymbolEntry[] = []
  const seen = new Set<string>()

  for (let i = 0; i < lines.length && entries.length < MAX_ENTRIES_PER_FILE; i++) {
    const line = lines[i] ?? ''
    if (line.length > 240) continue
    for (const pattern of patterns) {
      const match = line.match(pattern.re)
      const name = match?.[pattern.nameGroup ?? 1]
      if (!name) continue
      const key = `${pattern.kind}:${name}`
      if (seen.has(key)) break
      seen.add(key)
      const summary = nearbyComment(lines, i) ?? line.trim().replace(/\s+/g, ' ').slice(0, 140)
      entries.push({
        path,
        line: i + 1,
        kind: pattern.kind,
        name,
        summary,
      })
      break
    }
  }
  return entries
}

export function formatProjectSymbolIndex(index: ProjectSymbolIndex): string {
  const byFile = new Map<string, ProjectSymbolEntry[]>()
  for (const entry of index.entries) {
    const list = byFile.get(entry.path) ?? []
    list.push(entry)
    byFile.set(entry.path, list)
  }

  const lines = [
    '# Project symbol index',
    'Purpose: locate likely files and line ranges before using Read. This is an index, not source code and not edit permission.',
    `Scope: ${index.filesScanned}/${index.filesConsidered} candidate files scanned; ${index.entries.length} symbols listed${index.truncated ? ' (truncated)' : ''}.`,
    'Rule: before edit_file/write_file, call Read on the exact file/range and treat the current file body as authoritative.',
    '',
  ]

  if (index.entries.length === 0) {
    lines.push('No symbols found by the lightweight extractor. Use Grep/Glob for targeted discovery.')
    return lines.join('\n')
  }

  for (const [path, entries] of byFile) {
    lines.push(`## ${path}`)
    for (const entry of entries) {
      lines.push(`- L${entry.line} ${entry.name} (${entry.kind}) - ${entry.summary}`)
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

async function discoverCandidateFiles(projectPath: string): Promise<string[]> {
  const batches = await Promise.all(
    SOURCE_PATTERNS.map(pattern =>
      invoke<string[]>('glob_files', { pattern, directory: projectPath }).catch(() => []),
    ),
  )
  return uniqueSorted(batches.flat(), projectPath)
}

async function shouldReadFile(path: string): Promise<boolean> {
  try {
    const stat = await invoke<{ size: number }>('file_stat', { path })
    return typeof stat.size !== 'number' || stat.size <= MAX_FILE_BYTES
  } catch {
    return true
  }
}

export async function buildProjectSymbolIndex(projectPath: string): Promise<ProjectSymbolIndex> {
  const candidates = await discoverCandidateFiles(projectPath)
  const selected = candidates.slice(0, MAX_FILES_TO_SCAN)
  const entries: ProjectSymbolEntry[] = []
  let filesScanned = 0

  for (const absolutePath of selected) {
    if (entries.length >= MAX_ENTRIES) break
    if (!(await shouldReadFile(absolutePath))) continue
    const content = await cachedSafeReadFile(absolutePath)
    if (!content) continue
    filesScanned++
    const relativePath = toRelative(projectPath, absolutePath)
    const symbols = extractProjectSymbolsFromContent(relativePath, content)
    for (const symbol of symbols) {
      if (entries.length >= MAX_ENTRIES) break
      entries.push(symbol)
    }
  }

  return {
    entries,
    filesConsidered: candidates.length,
    filesScanned,
    truncated: candidates.length > selected.length || entries.length >= MAX_ENTRIES,
  }
}

export async function buildProjectSymbolIndexSection(projectPath: string): Promise<string> {
  const index = await buildProjectSymbolIndex(projectPath)
  const section = formatProjectSymbolIndex(index)
  markProjectSymbolIndexRequested({
    filesConsidered: index.filesConsidered,
    filesScanned: index.filesScanned,
    entries: index.entries.length,
    truncated: index.truncated,
    tokensEstimate: Math.ceil(section.length / 4),
  })
  return section
}
