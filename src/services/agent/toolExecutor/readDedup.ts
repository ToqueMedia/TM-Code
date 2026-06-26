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
 * The first gate is cheap: `fsVersion`, a global counter that increments on
 * every observed write. If it matches, no local tool write happened and the
 * cached content is still valid without touching disk.
 *
 * If `fsVersion` differs, the caller may pass a freshly-computed Rust SHA-256
 * signature or the freshly-read disk content. A signature match lets dedup
 * fire before fetching the full file body again; an exact string match is the
 * fallback when no signature is available.
 *
 * Adapted from claude-vaz's FileReadTool dedup logic (FileReadTool.ts:523-573).
 */

import type { FileContentSignature, FileStateCache } from './fileStateCache'

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
 *   2. The entry came from a prior Read (not from Edit/Write).
 *   3. The read range matches exactly (same offset + limit, including both
 *      undefined for a full-file read).
 *   4. Either:
 *      - the global fsVersion hasn't changed since the read; or
 *      - the caller provides currentSignature and it matches the cached
 *        model-visible signature; or
 *      - the caller provides currentContent and it exactly equals the cached
 *        model-visible content.
 *
 * Ranged reads that DON'T match the cached range are allowed through — the
 * model may need a different slice. Only exact same-range reads are deduped.
 *
 * @param filePath  Normalised absolute path
 * @param offset    1-based line offset (undefined = full file)
 * @param limit     Line limit (undefined = read to EOF)
 * @param readFileState  The content cache to check against
 * @param currentFsVersion  The current global fsVersion counter value
 * @param currentContent    Optional freshly-read disk content for an exact
 *                          second-stage equality check after fsVersion changed.
 * @param currentSignature  Optional freshly-computed disk signature. When it
 *                          matches the cached signature, dedup can fire before
 *                          reading the full file body.
 */
export function checkReadDedup(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  readFileState: FileStateCache,
  currentFsVersion: number,
  currentContent?: string,
  currentSignature?: FileContentSignature,
): DedupResult {
  const existingState = readFileState.get(filePath)

  // Only dedup entries that came from a prior Read. Full-file reads and writes
  // both store offset/limit as undefined, so source is the discriminator.
  if (
    !existingState ||
    existingState.source !== 'read' ||
    existingState.isPartialView
  ) {
    return { isDuplicate: false, stub: null }
  }

  // Range must match exactly
  const rangeMatch =
    existingState.offset === offset && existingState.limit === limit
  if (!rangeMatch) {
    return { isDuplicate: false, stub: null }
  }

  // Freshness check via fsVersion first. If the global counter changed, only
  // dedupe when the caller gives us a freshly-computed signature or content
  // that matches the cached model-visible state.
  if (currentFsVersion !== existingState.fsVersion) {
    if (
      currentSignature &&
      existingState.signature &&
      currentSignature.size === existingState.signature.size &&
      currentSignature.sha256 === existingState.signature.sha256
    ) {
      return { isDuplicate: true, stub: FILE_UNCHANGED_STUB }
    }
    if (currentContent !== undefined && currentContent === existingState.content) {
      return { isDuplicate: true, stub: FILE_UNCHANGED_STUB }
    }
    return { isDuplicate: false, stub: null }
  }

  return { isDuplicate: true, stub: FILE_UNCHANGED_STUB }
}
