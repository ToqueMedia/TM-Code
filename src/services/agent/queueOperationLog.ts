/**
 * Queue operation persistence — ported from Claude Code's
 * `recordQueueOperation` (utils/sessionStorage.ts).
 *
 * Each enqueue/dequeue/popAll/remove call appends a JSONL line to a
 * per-project log file in the app's project state directory.
 *
 * The log is fire-and-forget: write failures are swallowed to avoid
 * disturbing the queue's hot path. Logs are useful for replaying queue
 * history during debugging.
 *
 * Location: app-managed per-project state keyed by `.toquemedia-id`; sensitive
 * operation history does not clutter the repo tree.
 *
 * Adaptation: Claude Code uses a SQLite-backed `Project` instance with
 * `appendEntry`. TM Code uses a JSONL file via the new `append_file`
 * Tauri command, which avoids opening a connection per call.
 */

import { invoke } from '@/utils/invokeMetrics'
import { logger } from '../../utils/logger'
import type { QueueOperationMessage } from '../../types/messageQueueTypes'
import { getProjectSessionsDir } from '../projectStatePaths'

/** Resolved project context — set by the agent service after a project opens. */
let activeProjectPath: string | null = null
let activeSessionId: string | null = null

/**
 * Set the project path that operation logs should be scoped to.
 * Pass null to disable logging (e.g. on project close).
 */
export function setQueueLogContext(
  projectPath: string | null,
  sessionId: string | null,
): void {
  activeProjectPath = projectPath
  activeSessionId = sessionId
}

/** Read-only accessor — used by messageQueueManager to stamp the sessionId. */
export function getQueueLogSessionId(): string {
  return activeSessionId ?? 'unknown'
}

/** Read-only accessor — used by the queue snapshot persistence to route
 *  the disk write to the right project. Returns null when no project is
 *  open (boot, between-project state). */
export function getQueueLogProjectPath(): string | null {
  return activeProjectPath
}

async function resolveLogPath(projectPath: string): Promise<string> {
  return `${await getProjectSessionsDir(projectPath)}/queue-operations.jsonl`
}

/**
 * Append a single queue operation to the log. Fire-and-forget — errors
 * are logged at debug level only.
 */
export async function recordQueueOperation(queueOp: QueueOperationMessage): Promise<void> {
  if (!activeProjectPath) return // No project open — nothing to scope to.
  try {
    const path = await resolveLogPath(activeProjectPath)
    await invoke('append_file', {
      path,
      content: JSON.stringify(queueOp) + '\n',
    })
  } catch (err) {
    logger.debug('queue', 'Failed to append queue operation log:', err)
  }
}
