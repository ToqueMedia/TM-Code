/**
 * Per-project task tracker persistence.
 *
 * The agent's task tracker (the array of `{id, description, status}` rows
 * mutated by `update_tasks`) lives canonically on disk at
 * `<project>/.toquemedia/tasks.json`. The `agentStore` is a hot cache for
 * the UI, hydrated from disk on project open and written through on every
 * mutation.
 *
 * Why disk-canonical (not just zustand):
 *   - **App restart survives.** A budget interrupt that closes the chat,
 *     or a crash, or the user quitting the IDE between two phases of a
 *     plan execution — none of these should lose the tracker. Without
 *     disk persistence, the agent resuming after such a gap has to
 *     re-infer progress from filesystem state, which is exactly the
 *     failure mode we saw in the 2026-05-19 session (batch-completing
 *     12 → 23 in two calls because files existed).
 *
 *   - **Lives with the project, not the IDE.** The `.toquemedia/` folder
 *     is committable so the tracker can travel with the project to a new
 *     machine or even between developers; the next agent run sees the
 *     same state. Same logic as `.toquemedia-template` /
 *     `.toquemedia-id` already at the project root.
 *
 *   - **Fail-soft on first open.** When the file is missing the helper
 *     returns an empty array — the agent simply starts with a fresh
 *     tracker, no error surfaced to the developer.
 *
 * The Rust commands (`read_agent_state` / `write_agent_state`) validate
 * the filename and enforce path containment under `<project>/.toquemedia/`,
 * so this TS wrapper does no extra path work — it just (de)serialises.
 */

import { invoke } from '@tauri-apps/api/core'
import type { AgentTask } from '../../stores/agentStore'

const TASKS_FILENAME = 'tasks.json'

interface TasksFileV1 {
  /** Schema version — bumped if the on-disk shape ever changes (currently 1). */
  schemaVersion: 1
  /** ISO timestamp of the last write — useful for telemetry / debugging only. */
  updatedAt: string
  /** ISO timestamp when ALL tasks reached a terminal state (completed/failed/cancelled).
   *  Present means the tracker is archival — the next session starts fresh.
   *  loadTasksFromDisk returns [] when this field is set, keeping the store
   *  clean while preserving the completion record on disk for future review. */
  completedAt?: string
  tasks: AgentTask[]
}

/**
 * Read the tracker state for a project. Returns an empty array when the
 * file doesn't exist (first open, never persisted), throws only on real
 * I/O or parse failure so the caller can surface those distinctly.
 */
export async function loadTasksFromDisk(projectPath: string): Promise<AgentTask[]> {
  if (!projectPath) return []
  const raw = await invoke<string | null>('read_agent_state', {
    projectPath,
    filename: TASKS_FILENAME,
  })
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Partial<TasksFileV1>
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) {
      // Unknown shape (manual edit, future schema, corrupted file) — treat
      // as missing rather than throw. The agent restarts with an empty
      // tracker; the developer can re-seed via the next /plan or update_tasks
      // call. Trying to "recover" partial state would be more dangerous than
      // starting fresh.
      console.warn('[taskPersistence] tasks.json present but unrecognised shape; ignoring')
      return []
    }
    // If the tracker was previously fully completed (completedAt present),
    // don't load stale terminal tasks into the store — return empty so the
    // agent starts fresh. The disk record is preserved for review/export.
    if (parsed.completedAt) return []

    // Coerce status enum defensively — the on-disk file is a contract but
    // we don't want one bad row to wedge the whole tracker.
    const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed', 'cancelled'])
    return parsed.tasks.filter((t): t is AgentTask =>
      !!t
      && typeof t.id === 'string'
      && typeof t.description === 'string'
      && VALID_STATUSES.has(t.status)
      // Optional fields: allow string arrays or absent — reject malformed
      && (t.dependsOn === undefined || (Array.isArray(t.dependsOn) && t.dependsOn.every(v => typeof v === 'string')))
      && (t.blockedBy === undefined || (Array.isArray(t.blockedBy) && t.blockedBy.every(v => typeof v === 'string')))
      && (t.files === undefined || (Array.isArray(t.files) && t.files.every(v => typeof v === 'string'))),
    )
  } catch (err) {
    console.warn('[taskPersistence] failed to parse tasks.json:', err)
    return []
  }
}

/**
 * Write the current tracker to disk. Returns silently on success; errors
 * are logged but NOT re-thrown — a disk write failure must not block the
 * agent loop, the in-memory store remains the live view either way and
 * the next mutation will retry the persist.
 *
 * When ALL tasks are in a terminal state (completed/failed/cancelled),
 * the tracker is no longer needed for day-to-day steering — the next
 * session starts fresh via `completedAt`. Instead of deleting tasks.json
 * (which loses the completion record permanently), we PRESERVE the file
 * with a `completedAt` timestamp:
 *   1. The next session's loadTasksFromDisk returns [] (completedAt
 *      present), so the store stays clean — no stale "all done" rows.
 *   2. The developer retains the full task record on disk for review
 *      ("what did I accomplish?"), export, or audit.
 *   3. The `.toquemedia/` directory stays tidy — no fragmentation from
 *      repeated delete→re-create cycles across sessions.
 */
export async function saveTasksToDisk(projectPath: string, tasks: AgentTask[]): Promise<void> {
  if (!projectPath) return
  const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
  const allTerminal = tasks.length > 0 && tasks.every(t => TERMINAL.has(t.status))
  const payload: TasksFileV1 = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    ...(allTerminal ? { completedAt: new Date().toISOString() } : {}),
    tasks,
  }
  try {
    await invoke('write_agent_state', {
      projectPath,
      filename: TASKS_FILENAME,
      content: JSON.stringify(payload, null, 2),
    })
  } catch (err) {
    // Surface in logs only — agent flow must not break on a transient
    // I/O hiccup. The store keeps the live state; next mutation re-saves.
    console.warn('[taskPersistence] failed to write tasks.json:', err)
  }
}
