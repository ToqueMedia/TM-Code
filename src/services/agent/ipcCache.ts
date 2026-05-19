/**
 * Frontend cache for the two read IPCs that get called repeatedly inside a
 * single agent turn: `read_file` and `build_file_tree`.
 *
 * Why a cache here at all
 * -----------------------
 * The agent context-builder already memoises the FINAL prompt by
 * `(projectPath, projectType, …, fsVersion)`. When that cache hits, every
 * underlying read is skipped. When it MISSES — exactly one of the keys
 * changed — the orchestrator still re-runs the full `Promise.all([
 * buildFileTree, safeReadFile(README), safeReadFile(TMS), … ])`. The
 * `attachmentService` resolver, separately, also calls `read_file` and
 * `build_file_tree` for any folder/file attached in the same prompt — these
 * never went through the prompt cache, so on a turn with N attachments and
 * one context rebuild you get 2× the IPC traffic for the same paths.
 *
 * This file factors the dedupe one level lower: a tiny key-value cache
 * keyed by `(command, path, fsVersion)`. Reads coming from any caller hit
 * the same memo and a single IPC per path-version pair is what reaches Rust.
 *
 * Invalidation
 * ------------
 * Cache keys carry the current `fsVersion` (from `services/fsVersion.ts`).
 * Every write path in the IDE — agent tool execution, scaffolding, post-
 * scaffold pipelines, terminal commands the IDE knows about — calls
 * `bumpFsVersion()`. The next read with the same path produces a different
 * key and naturally misses, refetching the latest content.
 *
 * For the residual class of mutations the IDE does NOT observe (the user
 * editing the project from an external editor and switching back), a
 * conservative 5-second wall-clock TTL is layered on top of fsVersion. That
 * matches the latency between "I saved in VS Code" and "I switched back to
 * TM Code and pressed enter" — short enough that stale reads are bounded,
 * long enough that the cache still pays off for the burst of reads inside
 * one turn.
 *
 * Bypass
 * ------
 * Cache reads are read-only and produce the same string the IPC would.
 * Writers MUST go through the original `invoke('write_file', ...)` so the
 * fsVersion bump fires and our entries become stale on the very next read.
 * If a caller has a reason to skip the cache, calling `invoke` directly is
 * always safe.
 *
 * Bounds
 * ------
 * In-memory only; max ~512 entries per command, oldest evicted FIFO. That
 * sizes to several MB worst case and never grows further during long
 * sessions. No persistence: a fresh process starts cold.
 */
import { invoke } from '@/utils/invokeMetrics'
import { getFsVersion } from '../fsVersion'

interface CacheEntry<T> {
  value: T
  fsVersion: number
  storedAt: number
}

const CACHE_MAX_ENTRIES = 512
// Wall-clock safety net for external-editor mutations that don't bump
// fsVersion. Short on purpose: the cache exists to dedupe inside one
// turn, not to act as a long-lived snapshot.
const CACHE_MAX_AGE_MS = 5_000

function makeStore<T>(): {
  get: (key: string) => CacheEntry<T> | undefined
  set: (key: string, entry: CacheEntry<T>) => void
  clear: () => void
} {
  const map = new Map<string, CacheEntry<T>>()
  return {
    get: (key) => map.get(key),
    set: (key, entry) => {
      if (map.size >= CACHE_MAX_ENTRIES) {
        // FIFO eviction — Map preserves insertion order, so the first
        // key is the oldest. Cheap and good-enough for a per-session cache.
        const firstKey = map.keys().next().value
        if (firstKey !== undefined) map.delete(firstKey)
      }
      map.set(key, entry)
    },
    clear: () => map.clear(),
  }
}

const readFileStore = makeStore<string>()
const fileTreeStore = makeStore<unknown>()

function isFresh<T>(entry: CacheEntry<T> | undefined, currentFsVersion: number): entry is CacheEntry<T> {
  if (!entry) return false
  if (entry.fsVersion !== currentFsVersion) return false
  if (Date.now() - entry.storedAt > CACHE_MAX_AGE_MS) return false
  return true
}

/**
 * Cached `read_file`. Returns the same string the raw IPC would. On Rust
 * error the rejection is propagated to the caller — errors are never
 * cached, so the next attempt re-hits Rust and surfaces the live state.
 *
 * @param path Absolute path; relative paths are NOT normalised here and
 *             would key separately from their absolute form. Pass the same
 *             shape you'd pass to the underlying IPC.
 */
export async function cachedReadFile(path: string): Promise<string> {
  const fsVersion = getFsVersion()
  const key = path
  const hit = readFileStore.get(key)
  if (isFresh(hit, fsVersion)) return hit.value
  const value = await invoke<string>('read_file', { path })
  readFileStore.set(key, { value, fsVersion, storedAt: Date.now() })
  return value
}

/**
 * Same as `cachedReadFile`, but swallows rejection into `null` — matches
 * the shape of the existing `safeReadFile` helper so callers that depend
 * on "missing file → null, not throw" stay drop-in compatible. Null
 * results are NOT cached: a file that didn't exist when we last looked
 * may exist now, and probing the disk again is cheap when it really
 * doesn't.
 */
export async function cachedSafeReadFile(path: string): Promise<string | null> {
  try {
    return await cachedReadFile(path)
  } catch {
    return null
  }
}

// Index signature for compatibility with Tauri's `InvokeArgs` (= Record<string, unknown>).
// The IDE's call sites use the fields below; the index signature is required at the
// type level but not by any caller.
interface BuildFileTreeArgs {
  rootPath: string
  filter?: { showHidden?: boolean; maxDepth?: number }
  [key: string]: unknown
}

/**
 * Cached `build_file_tree`. Keyed by rootPath + filter shape — a different
 * `maxDepth` or `showHidden` is a different request and gets its own entry.
 * Generic so callers can keep their existing return type narrowing.
 */
export async function cachedBuildFileTree<T = unknown>(args: BuildFileTreeArgs): Promise<T> {
  const fsVersion = getFsVersion()
  const filterKey = `${args.filter?.showHidden ? '1' : '0'}|${args.filter?.maxDepth ?? -1}`
  const key = `${args.rootPath}|${filterKey}`
  const hit = fileTreeStore.get(key) as CacheEntry<T> | undefined
  if (isFresh(hit, fsVersion)) return hit.value
  const value = await invoke<T>('build_file_tree', args)
  fileTreeStore.set(key, { value, fsVersion, storedAt: Date.now() })
  return value
}

/** Test / debug helper — drop the entire cache. */
export function __resetIpcCacheForTests(): void {
  readFileStore.clear()
  fileTreeStore.clear()
}
