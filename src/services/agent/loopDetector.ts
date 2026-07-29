/**
 * Loop detector — identifies when the model is stuck in analysis paralysis.
 *
 * SRP: this module does ONE thing: detect repeated similar text outputs
 * without tool calls. It has zero dependencies on stores, services, or
 * the agent loop state. Pure functions operating on string fingerprints.
 *
 * OCP: add new similarity strategies by implementing the SimilarityStrategy
 * interface — the LoopDetector class doesn't need to change.
 */

import {
  LOOP_DETECTION_THRESHOLD,
  LOOP_SIMILARITY_MIN_LENGTH,
  LOOP_SIMILARITY_RATIO,
  TOOL_LOOP_NUDGE_THRESHOLD,
  TOOL_LOOP_STOP_THRESHOLD,
} from './agentConfig'

// ── Types ──

export interface LoopDetectorState {
  consecutiveSimilarTexts: number
  recentFingerprints: string[]
}

export interface LoopCheckResult {
  isLoop: boolean
  similarity: number
  count: number
}

// ── Pure functions ──

/**
 * Create a text fingerprint for similarity comparison.
 * Extracts key phrases by normalizing whitespace and stripping punctuation.
 */
export function computeTextFingerprint(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim()

  const first = normalized.slice(0, 500)
  const last = normalized.slice(-200)
  return `${first}|${last}`
}

/**
 * Jaccard similarity on word tokens between two fingerprints.
 * Returns 0..1 where 1 = identical word sets.
 */
export function computeSimilarity(fp1: string, fp2: string): number {
  if (fp1 === fp2) return 1.0

  const words1 = new Set(fp1.split(' '))
  const words2 = new Set(fp2.split(' '))

  const intersection = new Set([...words1].filter(w => words2.has(w)))
  const union = new Set([...words1, ...words2])

  return union.size === 0 ? 0 : intersection.size / union.size
}

/**
 * Check if a text output is part of a repetition loop.
 *
 * @param text The model's text output for this turn.
 * @param state Mutable detector state (mutated in place for efficiency).
 * @returns Whether a loop is detected and diagnostic info.
 */
export function checkForLoop(
  text: string,
  state: LoopDetectorState,
): LoopCheckResult {
  // Short text can't be meaningfully compared
  if (text.length < LOOP_SIMILARITY_MIN_LENGTH) {
    state.consecutiveSimilarTexts = 0
    return { isLoop: false, similarity: 0, count: 0 }
  }

  const fingerprint = computeTextFingerprint(text)
  state.recentFingerprints.push(fingerprint)

  // Keep only the last N fingerprints (2x threshold to allow reset)
  if (state.recentFingerprints.length > LOOP_DETECTION_THRESHOLD * 2) {
    state.recentFingerprints.shift()
  }

  if (state.recentFingerprints.length < 2) {
    return { isLoop: false, similarity: 0, count: state.consecutiveSimilarTexts }
  }

  // Compara com TODA a janela, não só com o imediatamente anterior (auditoria
  // 2026-07-28): a comparação 1-a-1 era cega à alternância A-B-A-B — cada
  // texto era "diferente do anterior" e o contador nunca subia, apesar de a
  // janela guardada (2x threshold) existir exatamente para ver mais longe.
  let similarity = 0
  for (let i = 0; i < state.recentFingerprints.length - 1; i++) {
    const s = computeSimilarity(fingerprint, state.recentFingerprints[i])
    if (s > similarity) similarity = s
  }

  if (similarity >= LOOP_SIMILARITY_RATIO) {
    state.consecutiveSimilarTexts++
  } else {
    state.consecutiveSimilarTexts = 0
  }

  return {
    isLoop: state.consecutiveSimilarTexts >= LOOP_DETECTION_THRESHOLD,
    similarity,
    count: state.consecutiveSimilarTexts,
  }
}

/**
 * Reset the detector state (call when tool calls are made — progress is happening).
 */
export function resetLoopDetector(state: LoopDetectorState): void {
  state.consecutiveSimilarTexts = 0
  state.recentFingerprints.length = 0
}

/**
 * Create a fresh detector state.
 */
export function createLoopDetectorState(): LoopDetectorState {
  return { consecutiveSimilarTexts: 0, recentFingerprints: [] }
}

// ── Tool-call loop detection ─────────────────────────────────────────────────
//
// The text detector above has a blind spot by construction: it only runs on
// turns with NO tool calls, and ANY tool call resets it (tool calls were taken
// as proof of progress). So the most expensive real failure mode — the model
// re-issuing the SAME call with the SAME args forever — was invisible to it.
// This half watches the tool side. Auditoria 2026-07-28.

export interface ToolLoopState {
  lastFingerprint: string | null
  /** How many times the current fingerprint repeated back-to-back. */
  repeatCount: number
  /** One nudge per streak — repeating it every turn would be its own spam. */
  nudged: boolean
}

export interface ToolLoopCheckResult {
  repeats: number
  shouldNudge: boolean
  shouldStop: boolean
}

/**
 * Tools whose whole PURPOSE is to be called repeatedly with identical args:
 * waiting on asynchronous work. Repetition here is the feature, not a loop.
 */
export const POLLING_TOOLS: ReadonlySet<string> = new Set([
  'agent_shell_read',
  'check_background_commands',
  'check_background_agents',
  'collect_results',
])

/**
 * Fingerprint a whole round of tool calls: names AND arguments, in order.
 *
 * Args are part of the identity on purpose — `read_file` on two different
 * paths is progress; `read_file` on the SAME path three times is not.
 *
 * Returns null when the round is exempt from loop detection (empty, or purely
 * polling), which the caller treats as "reset and skip".
 */
export function computeToolBatchFingerprint(
  calls: ReadonlyArray<{ name: string; argsJson?: string }>,
): string | null {
  if (calls.length === 0) return null
  if (calls.every((c) => POLLING_TOOLS.has(c.name))) return null
  return calls.map((c) => `${c.name}(${c.argsJson ?? ''})`).join('|')
}

/**
 * Track consecutive identical tool rounds.
 *
 * Escalates rather than killing outright: a model told what it is doing
 * usually breaks out on its own, and a hard stop on the 3rd repeat would
 * punish legitimate retries (a flaky command, a file being written by another
 * process). Only a model that ignores the nudge for as long again is stopped.
 */
export function checkForToolLoop(
  fingerprint: string | null,
  state: ToolLoopState,
): ToolLoopCheckResult {
  if (fingerprint === null) {
    state.lastFingerprint = null
    state.repeatCount = 0
    state.nudged = false
    return { repeats: 0, shouldNudge: false, shouldStop: false }
  }

  if (fingerprint !== state.lastFingerprint) {
    state.lastFingerprint = fingerprint
    state.repeatCount = 1
    state.nudged = false
    return { repeats: 1, shouldNudge: false, shouldStop: false }
  }

  state.repeatCount++
  const shouldStop = state.repeatCount >= TOOL_LOOP_STOP_THRESHOLD
  const shouldNudge =
    !shouldStop && !state.nudged && state.repeatCount >= TOOL_LOOP_NUDGE_THRESHOLD
  if (shouldNudge) state.nudged = true

  return { repeats: state.repeatCount, shouldNudge, shouldStop }
}

export function createToolLoopState(): ToolLoopState {
  return { lastFingerprint: null, repeatCount: 0, nudged: false }
}

/** Corrective text injected on the first detection of a repeated round. */
export function buildToolLoopNudgeText(repeats: number): string {
  return [
    `<system-reminder>`,
    `You have now issued the SAME tool call(s) with the SAME arguments ${repeats} times in a row, and the result has not changed.`,
    `Repeating it again will not produce a different answer. Change something concrete:`,
    `- different arguments (a different path, a wider or narrower pattern, an offset),`,
    `- a different tool, or`,
    `- accept the result as-is and continue the task with what you already know.`,
    `If the call is failing and you cannot work around it, say so plainly in your final answer and stop — do not keep retrying.`,
    `</system-reminder>`,
  ].join('\n')
}
