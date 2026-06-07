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

  const prevFingerprint = state.recentFingerprints[state.recentFingerprints.length - 2]
  const similarity = computeSimilarity(fingerprint, prevFingerprint)

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
