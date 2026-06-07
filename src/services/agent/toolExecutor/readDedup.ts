/**
 * Read dedup — avoids re-sending file content the model already has in context.
 *
 * When the model calls read_file on a path+range it has already read this
 * session, and the file hasn't changed on disk, we return a short stub
 * message instead of the full content. The earlier tool_result is still
 * in the conversation context — two full copies waste cache_creation tokens
 * on every subsequent turn.
 *
 * Claude Code's BQ proxy data: ~18% of Read calls are same-file collisions
 * (up to 2.64% of fleet cache_creation). Client-side dedup eliminates this
 * waste without any server-side changes.
 *
 * Freshness check
 * ---------------
 * Claude Code uses mtime (stat) for the freshness check. TM Code runs via
 * Tauri IPC and doesn't have a cheap `stat_file` command. Instead of reading
 * the file to compare hashes (which would defeat the purpose — reading the
 * file to decide whether to read the file), we use `fsVersion`: a global
 * counter that increments on every observed write (toolExecutor bumps it on
 * write_file / edit_file / create_file / delete_file / rename_file). If the
 * current fsVersion matches the one stored at read time, no writes have
 * occurred, so the cached content is still valid.
 *
 * This is slightly less precise than per-file mtime (a write to a DIFFERENT
 * file bumps the same global counter, causing a false negative — the dedup
 * won't fire even though our file is unchanged). But it's:
 *   - O(1) instead of O(file_size) — no IPC call at all
 *   - Conservative — never returns stale data (only skips dedup unnecessarily)
 *   - Identical to how the contextBuilder cache invalidation already works
 *
 * Adapted from claude-vaz's FileReadTool dedup logic (FileReadTool.ts:523-573).
 */

import type { FileStateCache } from './fileStateCache'

// ── Stub message ────────────────────────────────────────────────────────

/**
 * Returned instead of file content when the same file+range was already read
 * and the file is unchanged on disk. The model should use its existing
 * knowledge of the file rather than requesting the full content again.
 *
 * NOTE: We do NOT say "refer to the earlier tool_result" because compacted
 * conversations may have removed that result from the model's context.
 * Instead, we state the file is unchanged and let the model decide whether
 * it still has the content in its context window or needs to proceed
 * differently. If the content was compacted away, the model will re-read
 * on its own — no silent data loss.
 */
export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content you previously read is still current — use your existing knowledge of this file rather than requesting it again.'

// ── Dedup check ─────────────────────────────────────────────────────────

export interface DedupResult {
  /** True if the read should be stubbed (file unchanged, same range). */
  isDuplicate: boolean
  /** The stub message to return, or null if this is not a duplicate. */
  stub: string | null
}

/**
 * Check whether a read_file call can be deduped against a prior read.
 *
 * Conditions for dedup (mirrors claude-vaz):
 *   1. An existing cache entry exists for this file path.
 *   2. The entry came from a prior Read (offset is set, not from Edit/Write).
 *   3. The read range matches exactly (same offset + limit, or both full-file).
 *   4. The global fsVersion hasn't changed since the read (no writes occurred).
 *
 * Ranged reads that DON'T match the cached range are allowed through — the
 * model may need a different slice. Only exact same-range reads are deduped.
 *
 * @param filePath  Normalised absolute path
 * @param offset    1-based line offset (undefined = full file)
 * @param limit     Line limit (undefined = read to EOF)
 * @param readFileState  The content cache to check against
 * @param currentFsVersion  The current global fsVersion counter value
 */
export function checkReadDedup(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  readFileState: FileStateCache,
  currentFsVersion: number,
): DedupResult {
  const existingState = readFileState.get(filePath)

  // Only dedup entries that came from a prior Read (offset is always set
  // by Read). Edit/Write store offset=undefined — their readFileState
  // entry reflects post-edit content, so deduping against it would wrongly
  // point the model at the pre-edit Read content.
  if (
    !existingState ||
    existingState.offset === undefined
  ) {
    return { isDuplicate: false, stub: null }
  }

  // Range must match exactly
  const rangeMatch =
    existingState.offset === offset && existingState.limit === limit
  if (!rangeMatch) {
    return { isDuplicate: false, stub: null }
  }

  // Freshness check via fsVersion: if the global counter hasn't changed
  // since the read, no writes have occurred and the content is still valid.
  // If it HAS changed, a write might have touched this file — play it safe
  // and don't dedup. This is conservative: a write to a DIFFERENT file
  // also bumps the counter, causing a false negative. But it's O(1) and
  // never returns stale data.
  if (currentFsVersion !== existingState.fsVersion) {
    return { isDuplicate: false, stub: null }
  }

  return { isDuplicate: true, stub: FILE_UNCHANGED_STUB }
}
