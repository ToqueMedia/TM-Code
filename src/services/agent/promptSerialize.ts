/**
 * Serialize structured data for LLM *input* (tool results, context dumps).
 *
 * Policy from the 2026-07-24 TOON vs JSON vs domain bench (gpt-tokenizer):
 *
 * | Shape                                              | Winner      |
 * |----------------------------------------------------|-------------|
 * | Domain format available (search/tree/glob/tasks/…) | domain      |
 * | Primitive-leaf object arrays (MCP catalogs, …)     | TOON*       |
 * | Nested irregular / diffs / small objects           | JSON mini   |
 * | Pretty-printed JSON                                | never (prompt path) |
 *
 * *TOON is only kept when it is actually smaller than minified JSON
 *  (`toon.length <= mini.length * TOON_WIN_RATIO`). Heuristic alone is not enough.
 *
 * Domain formatters: `domainFormats.ts` + tool-local formatters in toolExecutor.
 * Minified JSON helper: `jsonMini.ts` (zero deps — hot paths import it directly).
 *
 * This module is the structured fallback for MCP-style object payloads and the
 * **only** place that imports `@toon-format/toon`. Do not re-export jsonMini or
 * domain formatters from here — that would reintroduce TOON into hot import graphs.
 *
 * Disk persistence and UI payloads (e.g. InlineDiff) are out of scope.
 */

import { encode as toonEncode } from '@toon-format/toon'
import { logger } from '@/utils/logger'
import { jsonMini } from './jsonMini'

/** TOON must beat mini by at least 10% chars or we keep mini (simpler for models). */
export const TOON_WIN_RATIO = 0.9

export type PromptSerializeFormat = 'string' | 'json_mini' | 'toon'

export interface PromptSerializeResult {
  text: string
  format: PromptSerializeFormat
  chars: number
}

/** Process-local counters for session export / debugging (not per-turn). */
export interface PromptSerializeStats {
  /** Plain strings passed through unchanged. */
  stringPassthrough: number
  /** Structured → JSON mini (default / fallback). */
  jsonMini: number
  /** TOON chosen because it won the size gate. */
  toonWins: number
  /** Tabular candidate but TOON not smaller enough — kept mini. */
  toonNoWin: number
  /** Tabular candidate but encode failed. */
  toonUnavailable: number
  /** Cumulative chars emitted as mini (json_mini outcomes only). */
  charsJsonMini: number
  /** Cumulative chars emitted as TOON. */
  charsToon: number
  /** Cumulative (mini - toon) when TOON wins — chars avoided vs mini. */
  charsSavedVsMini: number
}

function emptyStats(): PromptSerializeStats {
  return {
    stringPassthrough: 0,
    jsonMini: 0,
    toonWins: 0,
    toonNoWin: 0,
    toonUnavailable: 0,
    charsJsonMini: 0,
    charsToon: 0,
    charsSavedVsMini: 0,
  }
}

let stats: PromptSerializeStats = emptyStats()

/** Snapshot for session export / tests. */
export function getPromptSerializeStats(): Readonly<PromptSerializeStats> {
  return { ...stats }
}

/** Reset counters (tests, or start of a long-running session if desired). */
export function resetPromptSerializeStats(): void {
  stats = emptyStats()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Primitive-or-null leaf values (TOON tabular sweet spot — no nested objects). */
function isPrimitiveLeaf(value: unknown): boolean {
  if (value === null || value === undefined) return true
  const t = typeof value
  return t === 'string' || t === 'number' || t === 'boolean'
}

function rowIsPrimitiveObject(row: unknown): row is Record<string, unknown> {
  if (!isPlainObject(row)) return false
  for (const v of Object.values(row)) {
    if (!isPrimitiveLeaf(v)) return false
  }
  return true
}

/**
 * True when `value` is an array of ≥2 plain objects with only primitive leaves.
 * Key sets may differ (optional fields) — the size gate decides if TOON wins.
 */
export function isPrimitiveObjectArray(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < 2) return false
  if (!value.every(rowIsPrimitiveObject)) return false
  // At least one non-empty key set so we are not encoding [{}, {}].
  return Object.keys(value[0]).length > 0
}

/**
 * Prefer *trying* TOON when the payload looks tabular (or a shallow object
 * wrapping primitive-object arrays + primitives). Nested plain objects → mini.
 */
export function preferToon(value: unknown): boolean {
  if (isPrimitiveObjectArray(value)) return true
  if (!isPlainObject(value)) return false

  let sawTabular = false
  for (const v of Object.values(value)) {
    if (isPrimitiveLeaf(v)) continue
    if (Array.isArray(v)) {
      if (v.length === 0) continue
      if (isPrimitiveObjectArray(v)) {
        sawTabular = true
        continue
      }
      if (v.every(isPrimitiveLeaf)) continue
      return false
    }
    if (isPlainObject(v)) return false
    return false
  }
  return sawTabular
}

/** Encode with TOON; null on throw so callers fall back to mini. */
function tryToonEncode(value: unknown): string | null {
  try {
    return toonEncode(value)
  } catch {
    return null
  }
}

function logToonAttempt(result: PromptSerializeResult, reason: string): void {
  logger.debug(
    'agent',
    `promptSerialize format=${result.format} chars=${result.chars} (${reason})`,
  )
}

/**
 * Structured → prompt string + format metadata. Prefer this when you need to
 * log or assert which codec won.
 */
export function serializeStructuredForPromptDetailed(value: unknown): PromptSerializeResult {
  if (typeof value === 'string') {
    stats.stringPassthrough += 1
    return { text: value, format: 'string', chars: value.length }
  }

  const mini = jsonMini(value)
  if (!preferToon(value)) {
    stats.jsonMini += 1
    stats.charsJsonMini += mini.length
    return { text: mini, format: 'json_mini', chars: mini.length }
  }

  const toon = tryToonEncode(value)
  if (toon != null && toon.length <= mini.length * TOON_WIN_RATIO) {
    const result: PromptSerializeResult = { text: toon, format: 'toon', chars: toon.length }
    stats.toonWins += 1
    stats.charsToon += toon.length
    stats.charsSavedVsMini += mini.length - toon.length
    logToonAttempt(result, `toon_wins vs_mini=${mini.length}`)
    return result
  }

  const result: PromptSerializeResult = { text: mini, format: 'json_mini', chars: mini.length }
  if (toon == null) {
    stats.toonUnavailable += 1
    logToonAttempt(result, 'toon_unavailable')
  } else {
    stats.toonNoWin += 1
    logToonAttempt(result, `toon_no_win toon=${toon.length} mini=${mini.length}`)
  }
  stats.jsonMini += 1
  stats.charsJsonMini += mini.length
  return result
}

/**
 * Structured → prompt string. Callers that already have a domain formatter
 * should use that instead; this is the generic path (MCP results, …).
 */
export function serializeStructuredForPrompt(value: unknown): string {
  return serializeStructuredForPromptDetailed(value).text
}
