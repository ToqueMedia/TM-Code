/**
 * File state cache — stores file content read by the agent alongside metadata.
 *
 * Purpose
 * -------
 * The ToolExecutor's `readFileTimestamps` only stores { timestamp, hash } —
 * enough for read-before-write enforcement but NOT enough to avoid re-sending
 * the same file content to the model on redundant reads.
 *
 * This cache bridges that gap: it stores the ACTUAL file content so that:
 *
 *   1. **Dedup** — when the model reads the same file+range again and the
 *      file hasn't changed on disk, we return a short stub instead of the
 *      full content. Claude Code's BQ proxy showed ~18% of Read calls are
 *      same-file collisions, wasting cache_creation tokens.
 *
 *   2. **Resume** — after session resume, `extractReadFilesFromMessages`
 *      walks the conversation history and rebuilds the cache so the agent
 *      doesn't lose read-before-write state or dedup coverage.
 *
 * Architecture
 * ------------
 * Mirrors claude-vaz's `FileStateCache` (LRUCache, size-based eviction) but
 * adapted for the IDE's Tauri IPC environment (no Node fs, no FileHandle).
 *
 * - Path keys are normalised via `normalizePath()` (browser-safe, no Node
 *   `path` import — avoids Vite's "externalized for browser compatibility"
 *   error). Matches claude-vaz's `path.normalize()` semantics.
 * - Size-based eviction (default 25 MB) prevents unbounded memory growth.
 *   Uses `TextEncoder` instead of `Buffer.byteLength` for browser compat.
 * - Entry-count cap (default 100) provides a second bound.
 *
 * Lifecycle
 * ---------
 * - Created once by ToolExecutor (singleton pattern).
 * - Cleared on `resetSessionState()`.
 * - Rebuilt on resume by `extractReadFilesFromMessages()`.
 */

import { LRUCache } from 'lru-cache'

// ── Browser-safe path normalise ──────────────────────────────────────────

/**
 * Normalise a file path for consistent cache key lookups.
 *
 * Replaces Node's `path.normalize()` which is not available in the browser
 * (Vite externalises the `path` module). Handles:
 *   - Backslash → forward slash (Windows paths)
 *   - Duplicate slashes → single slash
 *   - `./` prefix removal
 *   - Trailing slash removal (unless root `/`)
 *
 * Does NOT resolve `..` segments — cache callers already use absolute paths.
 * This matches the practical effect of `path.normalize()` on absolute POSIX
 * paths (the dominant case in the IDE).
 */
function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  // Remove leading ./
  if (s.startsWith('./')) s = s.slice(2)
  // Remove trailing slash (keep root '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

// ── Browser-safe byte length ─────────────────────────────────────────────

const textEncoder = new TextEncoder()

/**
 * Get the byte length of a string (UTF-8). Replaces `Buffer.byteLength()`
 * which is not available in the browser.
 */
function byteLength(str: string): number {
  return textEncoder.encode(str).byteLength
}

// ── Types ───────────────────────────────────────────────────────────────

export interface FileState {
  /** Content shown to the model for this read: full file or requested range. */
  content: string
  /**
   * Timestamp when the file was read. Used by external-change sweeps and
   * read-before-write bookkeeping; dedup freshness primarily uses fsVersion
   * and can fall back to file signatures or exact content equality.
   */
  timestamp: number
  /**
   * Line offset of this read (1-based). `undefined` means a full-file read.
   * Ranged reads are stored and deduped only when the requested range matches
   * exactly; overlap dedup is handled by readRangeTracker.
   */
  offset: number | undefined
  /**
   * Line limit of this read. `undefined` means read-to-EOF.
   * Same dedup exclusion as offset: only exact-range matches dedup.
   */
  limit: number | undefined
  /**
   * Where this cache entry came from. Full-file reads and writes both have
   * offset/limit undefined, so dedup needs this source bit to avoid confusing
   * "the model already read this" with "the tool cache knows post-write text".
   */
  source?: 'read' | 'write'
  /**
   * Content signature from Rust. Stored only when known. Used to prove a file
   * is unchanged before fetching its full body again.
   */
  signature?: FileContentSignature
  /**
   * Simple hash of the content at read time — fast integer hash for
   * concurrent-modification detection without re-reading from disk.
   */
  hash: number
  /**
   * Global fsVersion at the time of this read. Incremented on every observed
   * write (see fsVersion.ts). Used by dedup as the cheap first freshness
   * check. If it differs, read_file can still suppress duplicate model tokens
   * by comparing a fresh Rust signature or freshly-read disk content against
   * this cached state.
   */
  fsVersion: number
  /**
   * True when this entry was populated by auto-injection (e.g. project memory
   * content injected into the system prompt) and the injected content did
   * not match disk (stripped HTML comments, stripped frontmatter, truncated
   * MEMORY.md). The model has only seen a partial view; Edit/Write must
   * require an explicit Read first. Mirrors claude-vaz's isPartialView.
   */
  isPartialView?: boolean
}

export interface FileContentSignature {
  path?: string
  size: number
  modifiedMs?: number | null
  sha256: string
}

// ── Defaults ────────────────────────────────────────────────────────────

/** Max entries in the cache — bounds the number of tracked files. */
export const READ_FILE_STATE_CACHE_SIZE = 100

/** Max total content size across all entries (25 MB). */
const DEFAULT_MAX_CACHE_SIZE_BYTES = 25 * 1024 * 1024

// ── Cache class ─────────────────────────────────────────────────────────

/**
 * A file-state cache that normalises all path keys before access.
 * Ensures consistent cache hits regardless of whether callers pass
 * relative vs absolute paths with redundant segments.
 */
export class FileStateCache {
  private cache: LRUCache<string, FileState>

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.cache = new LRUCache<string, FileState>({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: value => Math.max(1, byteLength(value.content)),
    })
  }

  get(key: string): FileState | undefined {
    return this.cache.get(normalizePath(key))
  }

  set(key: string, value: FileState): this {
    this.cache.set(normalizePath(key), value)
    return this
  }

  has(key: string): boolean {
    return this.cache.has(normalizePath(key))
  }

  delete(key: string): boolean {
    return this.cache.delete(normalizePath(key))
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }

  keys(): Generator<string> {
    return this.cache.keys()
  }

  entries(): Generator<[string, FileState]> {
    return this.cache.entries()
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Factory function to create a size-limited FileStateCache.
 * Images are not cached (they don't go through the text path), so the
 * size limit is mainly for large text files.
 */
export function createFileStateCacheWithSizeLimit(
  maxEntries: number = READ_FILE_STATE_CACHE_SIZE,
  maxSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES,
): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes)
}
