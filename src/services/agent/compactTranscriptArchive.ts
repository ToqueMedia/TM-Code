/**
 * Pre-compaction transcript archive.
 *
 * When the agent loop reaches the compression threshold, the older half of
 * the conversation gets condensed into a paragraph-long summary and the
 * raw messages are dropped from the live history. Useful for keeping the
 * token budget under control — disastrous when the model later needs an
 * exact code snippet, error message, or quoted user requirement that
 * lived in those compacted turns. The summary is by definition lossy.
 *
 * This module preserves the raw pre-compact transcript in the app's
 * per-project sessions dir so
 * the model can `read_file` the archive on demand — recovering the exact
 * tool result, the user's verbatim instruction, the original error
 * message, whatever the summary lossily collapsed.
 *
 * Each line of the JSONL is one message in its raw Anthropic shape (role
 * + content), preserving tool_use / tool_result content blocks intact.
 * That makes the archive trivially diffable, greppable, and feedable back
 * to any tool that expects the Anthropic message format.
 *
 * Rotation: keep the most recent 5 archives. Older ones rotate off because
 * the model never has reason to recall a compaction more than ~5 cycles
 * back (the conversation moved on; if a 5-old context still matters, the
 * relevant fact should have been promoted into a memdir entry by now).
 *
 * Failure mode: archive failures are logged but DO NOT block compaction.
 * The summary still proceeds; the model just won't have a transcript path
 * to fall back on. Logging vs throwing is the right trade-off — disk
 * issues should never make the agent loop hang on context overflow.
 */

import { invoke } from '@tauri-apps/api/core'
import { getProjectSessionsDir } from '../projectStatePaths'

const MAX_ARCHIVES_PER_SESSION = 5

/** Anthropic-shape message that the archive accepts. Same surface the
 *  compaction layer already operates on; the archive doesn't reshape. */
export interface ArchivedMessage {
  role: 'user' | 'assistant' | string
  content: string | Array<Record<string, unknown>> | null
}

/**
 * Write `messages` to the app per-project sessions archive file.
 * Picks the next available index (lowest unused 1..MAX_ARCHIVES), then if
 * MAX is reached, rotates: deletes the oldest, renames N→N-1, writes to
 * MAX. Returns the absolute path of the archive on success, or null when
 * the project path is missing / write failed.
 */
export async function archivePreCompactTranscript(
  projectPath: string,
  sessionId: string,
  messages: ArchivedMessage[],
): Promise<string | null> {
  if (!projectPath || !sessionId || messages.length === 0) return null

  const sessionsDir = await getProjectSessionsDir(projectPath)
  const archivePath = (n: number) =>
    `${sessionsDir}/${sessionId}.pre-compact-${n}.jsonl`

  // Probe which slots are taken. `list_directory` returns full paths or
  // basenames; we just want to know if our specific files exist. Cheap
  // to call read_file on each — file-missing returns an error we swallow.
  const slotsTaken: boolean[] = await Promise.all(
    Array.from({ length: MAX_ARCHIVES_PER_SESSION }, (_, i) =>
      invoke<string>('read_file', { path: archivePath(i + 1) })
        .then(() => true)
        .catch(() => false),
    ),
  )

  // Rotation strategy: if there's an unused slot, fill the highest empty
  // one. If all slots are taken, delete slot 1 (oldest) and shift 2..MAX
  // down by one — same N-deep ring buffer pattern as `find ~ -newer`
  // log rotators use.
  let targetIdx = slotsTaken.findIndex(t => !t)
  if (targetIdx === -1) {
    // Full — rotate. Delete oldest, shift down.
    try {
      await invoke('delete_file_or_directory', { path: archivePath(1) })
    } catch { /* missing is fine */ }
    for (let i = 2; i <= MAX_ARCHIVES_PER_SESSION; i++) {
      try {
        const content = await invoke<string>('read_file', { path: archivePath(i) })
        await invoke('write_file', { path: archivePath(i - 1), content })
        await invoke('delete_file_or_directory', { path: archivePath(i) })
      } catch {
        // Hole somewhere — best-effort, keep going.
      }
    }
    targetIdx = MAX_ARCHIVES_PER_SESSION - 1
  }

  const destPath = archivePath(targetIdx + 1)
  const jsonl = messages
    .map(m => JSON.stringify({ role: m.role, content: m.content }))
    .join('\n')

  try {
    await invoke('write_file', { path: destPath, content: jsonl + '\n' })
    return destPath
  } catch {
    return null
  }
}
