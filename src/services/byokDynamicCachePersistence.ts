/**
 * Cross-project cache for BYOK local-provider dynamic catalogs.
 *
 * Local providers (Ollama, LM Studio) expose a discovery endpoint that
 * returns the list of models currently pulled on the user's machine.
 * The IDE hits that endpoint via `refreshLocalModels()` on Settings open
 * and on store rehydrate. Without caching, every app launch does another
 * network round-trip even though the user's local model list rarely
 * changes between launches.
 *
 * The cache lives at `~/.tmcode/byok-dynamic-cache.json` —
 * per-user-machine (NOT per-project), because the models exposed by
 * Ollama on this machine apply to every project that uses BYOK against
 * Ollama. A user pulling a new model via `ollama pull` will see it after
 * the TTL expires (30 minutes) OR the next time they hit "Refresh" in
 * Settings.
 *
 * TTL strategy:
 *   - On load: return cached entries whose `fetchedAt` is younger than
 *     `MAX_CACHE_AGE_MS`. Stale entries are discarded (treated as a
 *     cache miss; caller re-fetches and re-caches).
 *   - Background-refresh hint: even when serving from cache, callers
 *     are expected to schedule a non-blocking `refreshLocalModels()`
 *     so the cache stays tight.
 */

import { invoke } from '@tauri-apps/api/core'
import type { ByokModel } from '../stores/byokStore'
import { appHomePath, legacyAppHomePath } from '../utils/appHomeDir'

const CACHE_FILENAME = 'byok-dynamic-cache.json'
const MAX_CACHE_AGE_MS = 30 * 60 * 1000 // 30 minutes

interface ByokCacheEntry {
  fetchedAt: number
  models: ByokModel[]
}

interface ByokCacheFileV1 {
  schemaVersion: 1
  updatedAt: string
  /** Map of `providerId` → cache entry. Lets a single file hold Ollama
   *  + LM Studio + any future local provider without separate files. */
  catalogs: Record<string, ByokCacheEntry>
}

async function cachePath(): Promise<string> {
  const home = await invoke<string>('get_home_directory')
  return appHomePath(home, CACHE_FILENAME)
}

async function readCacheRaw(): Promise<string> {
  const home = await invoke<string>('get_home_directory')
  try {
    return await invoke<string>('read_file', { path: appHomePath(home, CACHE_FILENAME) })
  } catch {
    return await invoke<string>('read_file', { path: legacyAppHomePath(home, CACHE_FILENAME) })
  }
}

/**
 * Read every cached entry. Returns a map `providerId → ByokCacheEntry`
 * for entries still within TTL. Stale entries are dropped silently so
 * the caller doesn't have to filter again.
 *
 * Returns an empty map when the file is missing, unparseable, or
 * every entry has expired.
 */
export async function loadByokDynamicCache(): Promise<Record<string, ByokCacheEntry>> {
  try {
    const raw = await readCacheRaw()
    const parsed = JSON.parse(raw) as Partial<ByokCacheFileV1>
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.catalogs) return {}
    const now = Date.now()
    const out: Record<string, ByokCacheEntry> = {}
    for (const [providerId, entry] of Object.entries(parsed.catalogs)) {
      if (
        entry
        && typeof entry.fetchedAt === 'number'
        && Array.isArray(entry.models)
        && now - entry.fetchedAt < MAX_CACHE_AGE_MS
      ) {
        out[providerId] = entry
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Write one provider's catalog into the cache file. Reads the existing
 * file first, merges this provider's entry in (other providers' entries
 * are preserved), and writes back.
 *
 * Read-modify-write isn't great for concurrent writes from multiple IDE
 * windows, but BYOK refresh is user-driven (Settings open / button click)
 * and rare enough that the race window is negligible. If it ever becomes
 * a problem, switch to one-file-per-provider.
 */
export async function saveByokDynamicCache(
  providerId: string,
  models: ByokModel[],
): Promise<void> {
  try {
    const path = await cachePath()
    let existing: Partial<ByokCacheFileV1> = {}
    try {
      const raw = await invoke<string>('read_file', { path })
      existing = JSON.parse(raw) as Partial<ByokCacheFileV1>
    } catch { /* file missing — start fresh */ }
    const catalogs = (existing.schemaVersion === 1 && existing.catalogs) || {}
    catalogs[providerId] = { fetchedAt: Date.now(), models }
    const payload: ByokCacheFileV1 = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      catalogs,
    }
    await invoke('write_file', {
      path,
      content: JSON.stringify(payload, null, 2),
    })
  } catch { /* swallow */ }
}
