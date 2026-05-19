/**
 * Message-queue snapshot persistence.
 *
 * `messageQueue.ts` holds a module-level `commandQueue: QueuedCommand[]`
 * that buffers user prompts while the agent is busy. The natural workflow
 * is: agent processes turn N, user types turn N+1 / N+2 / N+3 in advance
 * — those queue up and run sequentially. If the IDE crashes or is
 * force-quit while the queue has unprocessed entries, those prompts
 * vanish silently. The user has no way to recover what they typed.
 *
 * Snapshot file: `<project>/.toquemedia/sessions/<sessionId>.queue-snapshot.json`
 * — co-located with the rest of the session's files and gitignored via
 * the `.toquemedia/.gitignore` we already write.
 *
 * Lifecycle:
 *   - Written on every mutation (enqueue / dequeue / remove / clear),
 *     debounced 200ms. Short debounce because queue mutations are rare
 *     and the user really wants recovery to be tight.
 *   - Read on chat-session-load. If a snapshot exists for the (project,
 *     session) pair, the queue is rehydrated AFTER the existing queue is
 *     cleared (avoids dup re-runs from a session that was already active).
 *   - Deleted when the queue empties to zero — keeps the project tree
 *     clean.
 *
 * Per-session scope (not just per-project) because a user might have
 * multiple sessions for the same project with different queued work; we
 * don't want session A's pending prompts to run when the user opens
 * session B.
 */

import { invoke } from '@tauri-apps/api/core'
import type { QueuedCommand } from './messageQueue'

interface QueueSnapshotFileV1 {
  schemaVersion: 1
  updatedAt: string
  sessionId: string
  items: QueuedCommand[]
}

function snapshotPath(projectPath: string, sessionId: string): string {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  return `${normalized}/.toquemedia/sessions/${sessionId}.queue-snapshot.json`
}

export async function loadQueueSnapshot(
  projectPath: string,
  sessionId: string,
): Promise<QueuedCommand[]> {
  if (!projectPath || !sessionId) return []
  try {
    const raw = await invoke<string>('read_file', {
      path: snapshotPath(projectPath, sessionId),
    })
    const parsed = JSON.parse(raw) as Partial<QueueSnapshotFileV1>
    if (
      !parsed
      || parsed.schemaVersion !== 1
      || parsed.sessionId !== sessionId
      || !Array.isArray(parsed.items)
    ) {
      return []
    }
    return parsed.items
  } catch {
    return []
  }
}

export async function saveQueueSnapshot(
  projectPath: string,
  sessionId: string,
  items: readonly QueuedCommand[],
): Promise<void> {
  if (!projectPath || !sessionId) return
  const path = snapshotPath(projectPath, sessionId)
  // Empty queue → delete file rather than write an empty snapshot. The
  // gitignored `.toquemedia/sessions/` would otherwise accumulate stale
  // 0-item snapshots per session forever.
  if (items.length === 0) {
    try {
      await invoke('delete_file_or_directory', { path })
    } catch { /* swallow */ }
    return
  }
  const payload: QueueSnapshotFileV1 = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    sessionId,
    items: [...items],
  }
  try {
    await invoke('write_file', {
      path,
      content: JSON.stringify(payload, null, 2),
    })
  } catch { /* swallow */ }
}
