/**
 * Extract file-read state from conversation history for session resume.
 *
 * When a session is resumed (or compacted), the ToolExecutor's in-memory
 * `readFileTimestamps` and `readFileState` are empty — the agent has lost
 * all knowledge of which files it has read. This means:
 *
 *   1. Read-before-write enforcement breaks (model can write without reading).
 *   2. Dedup is ineffective (every read looks like a first read).
 *
 * This module walks the conversation history and reconstructs both the
 * lightweight `readFileTimestamps` map and the content-bearing `readFileState`
 * cache, so the agent resumes with full state.
 *
 * Adapted from claude-vaz's `extractReadFilesFromMessages` (queryHelpers.ts:346-501),
 * but uses the ContentBlockAPI format (tool_call/tool_result
 * as content blocks, not top-level fields).
 */

import type { FileStateCache } from './fileStateCache'
import type { ReadTimestamp } from './context'
import { FILE_UNCHANGED_STUB } from './readDedup'
import { simpleHash } from './checks'

// ── Types ───────────────────────────────────────────────────────────────

/**
 * Content block format — matches ContentBlockAPI from src/types/chat.ts.
 */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; toolCallId: string; content: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }

/**
 * Message shape from the conversation history.
 * Matches QueryMessage / ConversationMessage from src/types/chat.ts.
 */
interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[] | null
  timestamp?: number
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Strip `<system-reminder>...</system-reminder>` blocks from content.
 * These are injected for external-modification warnings and shouldn't
 * be stored as file content.
 */
function stripSystemReminders(content: string): string {
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

// ── Main extraction ─────────────────────────────────────────────────────

/**
 * Walk conversation history and rebuild file-read state.
 *
 * The API stores tool calls as content blocks:
 *   - Assistant messages contain `{ type: 'tool_call', id, name, arguments }` blocks
 *   - User messages contain `{ type: 'tool_result', toolCallId, content }` blocks
 *
 * Two-pass algorithm (mirrors claude-vaz):
 *   Pass 1: Find all read_file / write_file / edit_file tool_call blocks and
 *           map toolCallId → file metadata.
 *   Pass 2: Find the corresponding tool_result blocks and populate the caches.
 *
 * @param messages  Conversation history in chronological order
 * @param readFileState  The content cache to populate
 * @param readFileTimestamps  The lightweight timestamp+hash map to populate
 * @param _cwd  Current working directory (reserved for future use)
 * @param _invokeReadFile  Async function to read files from disk (reserved)
 */
export function extractReadFilesFromMessages(
  messages: ConversationMessage[],
  readFileState: FileStateCache,
  readFileTimestamps: Map<string, ReadTimestamp>,
  _cwd: string,
  _invokeReadFile: (path: string) => Promise<string>,
): void {
  // Pass 1: collect tool_call metadata from assistant messages
  const readFileUseIds = new Map<string, { filePath: string; offset: number | undefined; limit: number | undefined }>()
  const writeFileUseIds = new Map<string, { filePath: string; content: string }>()
  const editFileUseIds = new Map<string, string>() // toolCallId → filePath

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (block.type !== 'tool_call') continue
      const { id, name } = block
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(block.arguments || '{}') } catch { /* ignore parse errors */ }

      if (name === 'read_file') {
        const filePath = input.file_path as string | undefined
        if (!filePath) continue
        const offset = typeof input.offset === 'number' && input.offset > 0 ? input.offset : undefined
        const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : undefined
        readFileUseIds.set(id, { filePath, offset, limit })
      } else if (name === 'write_file') {
        const filePath = input.file_path as string | undefined
        const content = input.content as string | undefined
        if (filePath && content) {
          writeFileUseIds.set(id, { filePath, content })
        }
      } else if (name === 'edit_file') {
        const filePath = input.file_path as string | undefined
        if (filePath) {
          editFileUseIds.set(id, filePath)
        }
      }
    }
  }

  // Pass 2: find corresponding tool_result blocks in user messages
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      const { toolCallId, content: resultContent } = block

      // ── read_file results ──
      const readInfo = readFileUseIds.get(toolCallId)
      if (readInfo && typeof resultContent === 'string') {
        // Skip dedup stubs — they contain no file content; the earlier
        // real Read already cached it.
        if (resultContent.startsWith(FILE_UNCHANGED_STUB)) continue

        const processedContent = stripSystemReminders(resultContent)
        // TM Code's read_file does NOT use cat -n format (unlike claude-vaz),
        // so no line-number stripping is needed.

        const hash = simpleHash(processedContent)
        const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : Date.now()

        readFileState.set(readInfo.filePath, {
          content: processedContent,
          timestamp,
          offset: readInfo.offset,
          limit: readInfo.limit,
          source: 'read',
          hash,
          // Recovered entries use fsVersion=-1 (sentinel for "unknown") because
          // we don't know the fsVersion at the original read time. Since dedup
          // checks currentFsVersion !== entry.fsVersion, this sentinel ensures
          // recovered entries are never deduped (conservative: always re-read
          // after resume, never return stale data from cache). This is safe
          // because the real content is still in the conversation history —
          // re-reading just wastes a few cache_creation tokens.
          fsVersion: -1,
          // Historical toolCallId — the first request's visibility snapshot
          // classifies it (intact vs compacted), so mtime-gated dedup after
          // resume only stubs content the model can still actually see.
          toolCallId,
        })
        readFileTimestamps.set(readInfo.filePath, { timestamp, hash })
        continue // toolCallId matched — skip remaining checks
      }

      // ── write_file results ──
      const writeInfo = writeFileUseIds.get(toolCallId)
      if (writeInfo) {
        const hash = simpleHash(writeInfo.content)
        const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : Date.now()

        readFileState.set(writeInfo.filePath, {
          content: writeInfo.content,
          timestamp,
          offset: undefined, // Write entries have offset=undefined
          limit: undefined,
          source: 'write',
          hash,
          // Recovered write entries use fsVersion=-1 (sentinel for "unknown").
          // Write entries are excluded from dedup by source='write', so this
          // value is informational only.
          fsVersion: -1,
        })
        readFileTimestamps.set(writeInfo.filePath, { timestamp, hash })
        continue
      }

      // ── edit_file results ──
      // Post-edit content isn't in the tool use (only old/new string) nor
      // in the result (only a diff snippet). We mark the file as "read"
      // with a placeholder hash so read-before-write enforcement passes,
      // but dedup won't match (offset=undefined entries are excluded).
      const editFilePath = editFileUseIds.get(toolCallId)
      if (editFilePath) {
        const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : Date.now()
        readFileTimestamps.set(editFilePath, { timestamp, hash: 0 })
      }
    }
  }
}
