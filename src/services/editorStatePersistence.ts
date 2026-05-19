/**
 * Per-project editor dirty-buffer persistence.
 *
 * The editor's open-files list (paths + cursor positions + tab order) is
 * already persisted via Zustand's localStorage middleware (`editor-storage`
 * key). What was NOT persisted before this module: **dirty buffer content**
 * — unsaved edits the user has typed into the Monaco editor but hasn't yet
 * committed to disk.
 *
 * Without dirty-buffer persistence, the failure mode is silent and brutal:
 * user is editing a refactor across 3 files, autosave is off (or hasn't
 * fired yet because the debounce is still in flight), the IDE crashes or
 * the OS forces a reboot for an update → the rehydrate logic in
 * `editorStore.onRehydrateStorage` reads the files fresh from disk,
 * setting `isDirty: false` for everything. The unsaved edits are gone with
 * no warning.
 *
 * Storage: `<project>/.toquemedia/editor-state.json` with the shape:
 *   { schemaVersion, updatedAt, dirty: { [filePath]: content } }
 *
 * Only DIRTY files are written — clean files don't need to be re-snapshotted
 * because the disk version IS the truth. Cursor positions / tab order /
 * scroll position live in the existing localStorage persist path; this
 * file's job is strictly data recovery for unsaved work.
 *
 * Why per-project disk (and not localStorage):
 *   - localStorage has a ~5-10MB hard limit shared across ALL projects;
 *     dirty buffers in a single project can exceed that easily.
 *   - The state is project-scoped, not user-scoped — it should travel
 *     with the project (move folders between machines, etc.).
 *   - The file is gitignored (sessions/ pattern covers it via the same
 *     `.toquemedia/.gitignore` Rust helper) — unsaved work is by
 *     definition not yet committable.
 */

import { invoke } from '@tauri-apps/api/core'

const EDITOR_STATE_FILENAME = 'editor-state.json'

interface EditorStateFileV1 {
  /** Schema version — bumped if the on-disk shape ever changes. */
  schemaVersion: 1
  /** ISO timestamp of the last write. */
  updatedAt: string
  /** Map of absolute file path → unsaved buffer content. Only entries
   *  for files the user has touched since the last save appear here. */
  dirty: Record<string, string>
}

function editorStatePath(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  return `${normalized}/.toquemedia/${EDITOR_STATE_FILENAME}`
}

/**
 * Read the dirty-buffer map for a project. Returns an empty object when
 * the file doesn't exist (clean state, nothing was unsaved).
 */
export async function loadEditorStateFromDisk(
  projectPath: string,
): Promise<Record<string, string>> {
  if (!projectPath) return {}
  try {
    const raw = await invoke<string>('read_file', { path: editorStatePath(projectPath) })
    const parsed = JSON.parse(raw) as Partial<EditorStateFileV1>
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.dirty !== 'object' || parsed.dirty === null) {
      return {}
    }
    // Defensive: filter out non-string entries — single bad row mustn't
    // wedge the whole hydrate.
    const out: Record<string, string> = {}
    for (const [path, content] of Object.entries(parsed.dirty)) {
      if (typeof path === 'string' && typeof content === 'string') {
        out[path] = content
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Persist the dirty-buffer map for a project. When `dirty` is empty (every
 * open file is in sync with disk), delete the file rather than writing an
 * empty object — keeps the project tree clean for users who never have
 * unsaved edits at IDE-close time.
 */
export async function saveEditorStateToDisk(
  projectPath: string,
  dirty: Record<string, string>,
): Promise<void> {
  if (!projectPath) return
  const path = editorStatePath(projectPath)
  if (Object.keys(dirty).length === 0) {
    try {
      await invoke('delete_file_or_directory', { path })
    } catch { /* swallow */ }
    return
  }
  const payload: EditorStateFileV1 = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    dirty,
  }
  try {
    await invoke('write_file', {
      path,
      content: JSON.stringify(payload, null, 2),
    })
  } catch { /* swallow — in-memory remains live */ }
}
