import { logger } from '../utils/logger'

export interface QuickOpenItem {
  path: string
  name: string
  score: number
  isDirectory?: boolean
}

interface IndexEntry {
  path: string
  isDirectory: boolean
  /** Last time the user selected / referenced this entry — for recency bias. */
  lastUsed?: number
}

// Directories we refuse to walk. Lowercased. Covers node tooling, Python,
// Rust, Go/PHP, IDEs, common build output dirs across major frameworks.
const IGNORE_DIR_NAMES = new Set<string>([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.turbo',
  '.cache',
  'coverage',
  '.nyc_output',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  'target',
  'vendor',
  '.idea',
  '.vscode',
  '.vs',
  '.gradle',
  '.terraform',
  '.dart_tool',
  'derived_data',
  'pods',
  '.expo',
  'tmp',
  '.tmp',
])

const IGNORE_FILE_EXT = new Set<string>([
  'rlib', 'rmeta', 'pyc', 'pyo', 'class', 'o', 'obj', 'so', 'dylib', 'dll',
  'exe', 'lock',
])

function splitPath(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter(Boolean)
}

function getFileName(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || p
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

export default class QuickOpenService {
  private static instance: QuickOpenService
  private rootPath: string | null = null
  private index: IndexEntry[] = []
  private pathToEntry: Map<string, IndexEntry> = new Map()
  private building = false
  private listeners: Set<() => void> = new Set()
  private version = 0
  /** Monotonic counter used to cancel in-flight builds. */
  private buildToken = 0
  /** Unsubscribe for the live filesystem watcher, if any. */
  private watcherCleanup: (() => void) | null = null

  static getInstance(): QuickOpenService {
    if (!QuickOpenService.instance) {
      QuickOpenService.instance = new QuickOpenService()
    }
    return QuickOpenService.instance
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getVersion(): number { return this.version }
  isBuilding(): boolean { return this.building }
  isReady(): boolean { return !this.building && this.index.length > 0 }
  getSize(): number { return this.index.length }
  getRootPath(): string | null { return this.rootPath }

  private notify(): void {
    this.version++
    this.listeners.forEach(l => { try { l() } catch { /* ignore */ } })
  }

  async initialize(rootPath: string): Promise<void> {
    if (this.rootPath === rootPath && this.index.length > 0 && !this.building) {
      return
    }
    // Cancel any in-flight build, tear down any live watcher, reset state.
    this.buildToken++
    this.stopWatcher()
    this.rootPath = rootPath
    this.index = []
    this.pathToEntry.clear()
    this.notify()
    await this.buildIndex()
    // Start live watcher only after the initial index has settled.
    this.startWatcher().catch(err => logger.warn('quick-open', 'watcher start failed', err))
  }

  async reset(): Promise<void> {
    this.buildToken++
    this.stopWatcher()
    this.rootPath = null
    this.index = []
    this.pathToEntry.clear()
    this.building = false
    this.notify()
  }

  /** Force a full rebuild — used after destructive operations (clone, reset). */
  async refresh(): Promise<void> {
    if (!this.rootPath) return
    this.buildToken++
    this.index = []
    this.pathToEntry.clear()
    this.notify()
    await this.buildIndex()
  }

  async buildIndex(): Promise<void> {
    if (!this.rootPath) return
    // NOTE: no `if (this.building) return` guard. The token mechanism below
    // already handles concurrent builds — the loser exits early inside the loop
    // and the winner's `finally` writes the final state. The early-exit used
    // to leak `building=true` forever whenever React StrictMode's double-mount
    // (or any rapid re-initialize) called buildIndex while an older run was
    // still cancelling: the older run's `finally` saw a token mismatch and
    // refused to reset `building`, while the newer run never got to run at all.

    // Safety: refuse to index overly broad paths (home dir, FS root, etc.)
    // See memory: broad recursive FSEvents on $HOME freezes the app.
    const normalised = this.rootPath.replace(/\\/g, '/').replace(/\/$/, '')
    const depth = normalised.split('/').filter(Boolean).length
    if (depth < 3) return

    const myToken = ++this.buildToken
    this.building = true
    this.notify()

    const targetRoot = this.rootPath
    const entriesOut: IndexEntry[] = []
    const pathSet: Map<string, IndexEntry> = new Map()
    const visited: Set<string> = new Set()

    try {
      const fs = await import('@tauri-apps/plugin-fs')
      const stack: string[] = [targetRoot]

      while (stack.length > 0) {
        // Cancellation check — exits immediately on token bump.
        if (myToken !== this.buildToken) return

        const current = stack.pop() as string

        // Cycle detection via canonical path (readlink-backed when possible).
        // readLink resolves one hop; we canonicalise best-effort, swallowing errors.
        let canonical = current
        try {
          // plugin-fs exposes no realpath in all versions — fall back to the raw
          // string. For most projects, symlinks in-tree are rare.
          canonical = current.replace(/\/+$/, '')
        } catch { /* ignore */ }
        if (visited.has(canonical)) continue
        visited.add(canonical)

        let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }> = []
        try {
          entries = await fs.readDir(current)
        } catch {
          continue
        }

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]
          const n: string = entry.name || ''
          if (!n) continue
          if (n.startsWith('.') && n !== '.env') continue

          const p: string = current.includes('\\')
            ? `${current}\\${n}`
            : `${current}/${n}`

          if (entry.isDirectory) {
            if (IGNORE_DIR_NAMES.has(n.toLowerCase())) continue
            // Skip known symlinks when we can detect them — avoids the textbook
            // `a/b -> ../a` infinite loop.
            if (entry.isSymlink) continue
            const e: IndexEntry = { path: p, isDirectory: true }
            entriesOut.push(e)
            pathSet.set(p, e)
            stack.push(p)
          } else {
            const ext = getExtension(n)
            if (IGNORE_FILE_EXT.has(ext)) continue
            const e: IndexEntry = { path: p, isDirectory: false }
            entriesOut.push(e)
            pathSet.set(p, e)
          }
        }
      }

      // Apply the result only if we're still the active build and root match.
      if (myToken === this.buildToken && this.rootPath === targetRoot) {
        this.index = entriesOut
        this.pathToEntry = pathSet
      }
    } finally {
      // Only clear `building` when we're the winning build, so a later
      // cancelled build doesn't flap the UI state.
      if (myToken === this.buildToken) {
        this.building = false
        this.notify()
      }
    }
  }

  // ─── Live updates ────────────────────────────────────────────────────────

  /** Public: add a single entry incrementally (e.g. after agent writes a file). */
  addEntry(path: string, isDirectory: boolean): void {
    if (!this.rootPath) return
    if (this.pathToEntry.has(path)) return
    const name = getFileName(path)
    if (!name) return
    if (isDirectory && IGNORE_DIR_NAMES.has(name.toLowerCase())) return
    if (!isDirectory && IGNORE_FILE_EXT.has(getExtension(name))) return
    // Refuse entries that fall under an ignored ancestor (e.g. target/).
    const parts = splitPath(path)
    for (const seg of parts) {
      if (IGNORE_DIR_NAMES.has(seg.toLowerCase())) return
    }
    const entry: IndexEntry = { path, isDirectory }
    this.pathToEntry.set(path, entry)
    this.index.push(entry)
    this.notify()
  }

  /** Public: remove a single entry (or any that prefix-match, for dir deletion). */
  removeEntry(path: string): void {
    if (!this.pathToEntry.has(path) && !this.index.some(e => e.path.startsWith(path + '/') || e.path.startsWith(path + '\\'))) {
      return
    }
    const prefix1 = path + '/'
    const prefix2 = path + '\\'
    this.index = this.index.filter(e => {
      if (e.path === path) { this.pathToEntry.delete(e.path); return false }
      if (e.path.startsWith(prefix1) || e.path.startsWith(prefix2)) {
        this.pathToEntry.delete(e.path)
        return false
      }
      return true
    })
    this.notify()
  }

  /** Public: nudge recency for a path — lifts it in future result ordering. */
  markUsed(path: string): void {
    const e = this.pathToEntry.get(path)
    if (!e) return
    e.lastUsed = Date.now()
  }

  // ─── Watcher ─────────────────────────────────────────────────────────────

  private async startWatcher(): Promise<void> {
    if (!this.rootPath) return
    if (this.watcherCleanup) return
    try {
      const { watch } = await import('@tauri-apps/plugin-fs')
      const root = this.rootPath
      const unwatch = await watch(
        root,
        (event) => {
          try {
            const paths: string[] = Array.isArray(event.paths) ? event.paths : []
            const kind = event.type
            const kindStr = typeof kind === 'string' ? kind : Object.keys(kind || {})[0] || ''

            for (const p of paths) {
              // Cheap filter: drop events inside any ignored directory.
              const segments = splitPath(p)
              if (segments.some(s => IGNORE_DIR_NAMES.has(s.toLowerCase()))) continue

              if (kindStr === 'create' || kindStr === 'rename') {
                // We don't know if it's a file or dir without stat(). Best-effort:
                // check suffix for a dot to guess. Probe lazily.
                void this.probeAndAdd(p)
              } else if (kindStr === 'remove' || kindStr === 'delete') {
                this.removeEntry(p)
              }
              // modify / update doesn't change index shape — ignore.
            }
          } catch (err) {
            logger.warn('quick-open', 'watcher handler error', err)
          }
        },
        { recursive: true },
      )
      this.watcherCleanup = () => {
        try { unwatch() } catch { /* ignore */ }
      }
    } catch (err) {
      // Watcher is best-effort; tauri plugin may not support on this platform.
      logger.warn('quick-open', 'file watcher unavailable', err)
    }
  }

  private async probeAndAdd(path: string): Promise<void> {
    if (this.pathToEntry.has(path)) return
    try {
      const { stat } = await import('@tauri-apps/plugin-fs')
      const info = await stat(path)
      this.addEntry(path, !!info.isDirectory)
    } catch {
      // File may have been deleted before we could stat; ignore.
    }
  }

  private stopWatcher(): void {
    if (this.watcherCleanup) {
      this.watcherCleanup()
      this.watcherCleanup = null
    }
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  /**
   * First N entries without filtering. Used for the `@` trigger with no query.
   * Prefers recently-used entries, then directories for navigation, then files.
   */
  list(limit: number = 30, includeDirectories: boolean = false): QuickOpenItem[] {
    const source = includeDirectories ? this.index : this.index.filter(e => !e.isDirectory)
    const now = Date.now()
    const sorted = source.slice().sort((a, b) => {
      const aUsed = a.lastUsed || 0
      const bUsed = b.lastUsed || 0
      if (aUsed || bUsed) {
        // Newer use wins; decay linearly is unnecessary for a shortlist.
        return bUsed - aUsed
      }
      // Stable fallback: directories first (easier to drill down), then
      // shorter paths (likely top-level, more relevant).
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.path.length - b.path.length
    })
    void now
    return sorted.slice(0, limit).map(e => ({
      path: e.path,
      name: getFileName(e.path),
      score: 0,
      isDirectory: e.isDirectory,
    }))
  }

  /**
   * Query the index. Combines three signals:
   *   1. substring match on the file name — strongest
   *   2. fuzzy (subsequence) match on the name with word-boundary bonus
   *   3. substring match on the full relative path — weakest
   * Ties broken by recency, then by path length.
   */
  search(query: string, limit: number = 100, includeDirectories: boolean = false): QuickOpenItem[] {
    const q = query.trim()
    if (q.length === 0) return []
    const lq = q.toLowerCase()
    const results: Array<{ entry: IndexEntry; score: number; name: string }> = []

    for (let i = 0; i < this.index.length; i++) {
      const entry = this.index[i]
      if (!includeDirectories && entry.isDirectory) continue
      const name = getFileName(entry.path)
      const ln = name.toLowerCase()
      const lp = entry.path.toLowerCase()

      let score = 0

      // 1. Substring on name.
      const nameIdx = ln.indexOf(lq)
      if (nameIdx !== -1) {
        score += 1000 - Math.min(nameIdx * 4, 400)
        if (nameIdx === 0) score += 200 // prefix match is a big deal
        if (ln === lq) score += 500
      } else {
        // 2. Fuzzy subsequence on name.
        const fuzzy = fuzzyScore(lq, ln)
        if (fuzzy > 0) score += fuzzy
      }

      // 3. Substring on path (weak signal — only if we already have some).
      const pathIdx = lp.indexOf(lq)
      if (pathIdx !== -1 && nameIdx === -1) {
        score += 100 - Math.min(pathIdx, 100)
      }

      if (score <= 0) continue

      // Nudges.
      if (entry.isDirectory) score -= 10 // let files rank above dirs on ties
      if (entry.lastUsed) {
        const ageMs = Date.now() - entry.lastUsed
        if (ageMs < 60_000) score += 80
        else if (ageMs < 10 * 60_000) score += 40
        else if (ageMs < 60 * 60_000) score += 15
      }
      // Short paths are usually more relevant (root / src / …).
      const depth = splitPath(entry.path).length
      score -= depth

      results.push({ entry, score, name })
    }

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      // Deterministic tiebreaker.
      return a.entry.path.localeCompare(b.entry.path)
    })

    return results.slice(0, limit).map(r => ({
      path: r.entry.path,
      name: r.name,
      score: r.score,
      isDirectory: r.entry.isDirectory,
    }))
  }
}

/**
 * Classic subsequence fuzzy matcher — every char of `q` must appear in `s` in
 * order. Rewards consecutive matches and matches at word boundaries
 * (after '/', '.', '-', '_'). Returns 0 when q is not a subsequence.
 */
function fuzzyScore(q: string, s: string): number {
  let qi = 0
  let score = 0
  let lastMatch = -2
  for (let i = 0; i < s.length; i++) {
    if (s[i] === q[qi]) {
      if (i === lastMatch + 1) score += 8 // consecutive
      else score += 2
      const prev = i > 0 ? s[i - 1] : ''
      if (prev === '' || prev === '/' || prev === '\\' || prev === '.' || prev === '-' || prev === '_') {
        score += 6 // word boundary
      }
      lastMatch = i
      qi++
      if (qi === q.length) break
    }
  }
  if (qi < q.length) return 0
  // Penalise long strings where matches are spread out.
  score -= Math.floor((s.length - q.length) / 8)
  return Math.max(1, score)
}
