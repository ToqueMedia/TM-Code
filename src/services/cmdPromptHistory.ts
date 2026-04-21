/**
 * Per-project CMD-mode prompt history, persisted to IndexedDB.
 *
 * Performance strategy:
 *   - The hook keeps the **in-memory** array as the source of truth for
 *     ArrowUp/Down navigation — IDB is never on the keystroke path.
 *   - On mount, load once from IDB and seed the in-memory array (async, UI
 *     stays responsive; empty → array stays empty until data arrives).
 *   - On send, update memory first, then fire-and-forget a write. One IDB
 *     transaction per sent prompt (~ms), well under human perception.
 *
 * Native IndexedDB — no extra dep. All async. Gracefully no-ops when IDB is
 * unavailable (Firefox private mode, old Electron, test env without fake-idb).
 */

import { logger } from '../utils/logger'

const DB_NAME = 'tm-code-cmd'
const DB_VERSION = 1
const STORE = 'promptHistory'

/** Upper bound for persisted + in-memory history entries per project. Exported
 *  so the hook shares the same cap — no drift between memory and disk. */
export const MAX_PROMPT_HISTORY = 100

interface HistoryRecord {
  projectPath: string
  prompts: string[]
  updatedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null
let warnedOnce = false

/** Reset the memoized db connection — used by tests to rebind after a fresh
 *  fake-indexeddb install. No-op in production. */
export function __resetDbForTests(): void {
  dbPromise = null
  warnedOnce = false
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      if (!warnedOnce) {
        logger.warn('cmd', 'IndexedDB unavailable — prompt history will not persist across reloads.')
        warnedOnce = true
      }
      resolve(null)
      return
    }
    let settled = false
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'projectPath' })
        }
      }
      req.onsuccess = () => {
        if (!settled) { settled = true; resolve(req.result) }
      }
      req.onerror = () => {
        if (!warnedOnce) {
          logger.warn('cmd', 'IndexedDB open failed — prompt history will not persist:', req.error?.message)
          warnedOnce = true
        }
        if (!settled) { settled = true; resolve(null) }
      }
      req.onblocked = () => {
        // Treat as unavailable — caller falls back to in-memory-only mode.
        if (!settled) { settled = true; resolve(null) }
      }
    } catch (err) {
      if (!warnedOnce) {
        logger.warn('cmd', 'IndexedDB open threw — prompt history disabled:', err)
        warnedOnce = true
      }
      resolve(null)
    }
  })
  return dbPromise
}

export async function loadPromptHistory(projectPath: string): Promise<string[]> {
  if (!projectPath) return []
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const store = tx.objectStore(STORE)
      const req = store.get(projectPath)
      req.onsuccess = () => {
        const rec = req.result as HistoryRecord | undefined
        resolve(rec?.prompts ?? [])
      }
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

export async function savePromptHistory(projectPath: string, prompts: string[]): Promise<void> {
  if (!projectPath) return
  const db = await openDb()
  if (!db) return
  const trimmed = prompts.slice(0, MAX_PROMPT_HISTORY)
  const record: HistoryRecord = {
    projectPath,
    prompts: trimmed,
    updatedAt: Date.now(),
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

/**
 * Reset-listeners — fires after a successful clear so in-memory consumers (the
 * CMD prompt hook) can drop their local cache without needing a reload.
 */
type ResetListener = (projectPath: string) => void
const resetListeners = new Set<ResetListener>()

export function onHistoryReset(listener: ResetListener): () => void {
  resetListeners.add(listener)
  return () => { resetListeners.delete(listener) }
}

/** Delete all persisted prompts for one project. Notifies listeners so the
 *  hook can clear its in-memory ref too. */
export async function clearPromptHistory(projectPath: string): Promise<void> {
  if (!projectPath) return
  const db = await openDb()
  if (!db) {
    // Even without IDB, notify listeners so the in-memory history is cleared.
    for (const fn of resetListeners) {
      try { fn(projectPath) } catch { /* swallow */ }
    }
    return
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(projectPath)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
  for (const fn of resetListeners) {
    try { fn(projectPath) } catch { /* swallow */ }
  }
}

/**
 * Merge freshly-loaded persisted history with any entries the caller has
 * already accumulated in memory (e.g. a send that fired during the IDB read).
 * Memory wins on dedup so the most recent user action stays at index 0.
 *
 * Pure — safe to unit-test in isolation from IndexedDB.
 */
export function mergePromptHistory(memory: string[], persisted: string[]): string[] {
  const seen = new Set(memory)
  const merged: string[] = [...memory]
  for (const p of persisted) {
    if (!seen.has(p)) {
      merged.push(p)
      seen.add(p)
    }
  }
  return merged.slice(0, MAX_PROMPT_HISTORY)
}
