/**
 * Queue operation persistence — ported from Claude Code's
 * `recordQueueOperation` (utils/sessionStorage.ts).
 *
 * Each enqueue/dequeue/popAll/remove call appends a JSONL line to a
 * per-project log file at
 *   <project>/.toquemedia/sessions/queue-operations.jsonl
 *
 * The log is fire-and-forget: write failures are swallowed to avoid
 * disturbing the queue's hot path. Logs are useful for replaying queue
 * history during debugging.
 *
 * Location: 2026-05 migration moved this out of the home-dir-keyed-by-
 * hash layout and into the project's own `.toquemedia/sessions/` —
 * gitignored (sensitive operation history) but travels with the project.
 *
 * Adaptation: Claude Code uses a SQLite-backed `Project` instance with
 * `appendEntry`. TM Code uses a JSONL file via the new `append_file`
 * Tauri command, which avoids opening a connection per call.
 */

import { invoke } from '@/utils/invokeMetrics'
import { logger } from '../../utils/logger'
import type { QueueOperationMessage } from '../../types/messageQueueTypes'

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

function resolveLogPath(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  return `${normalized}/.toquemedia/sessions/queue-operations.jsonl`
}

/**
 * Append a single queue operation to the log. Fire-and-forget — errors
 * are logged at debug level only.
 */
export async function recordQueueOperation(queueOp: QueueOperationMessage): Promise<void> {
  if (!activeProjectPath) return // No project open — nothing to scope to.
  try {
    const path = resolveLogPath(activeProjectPath)
    await invoke('append_file', {
      path,
      content: JSON.stringify(queueOp) + '\n',
    })
  } catch (err) {
    logger.debug('queue', 'Failed to append queue operation log:', err)
  }
}
