/**
 * Compact module — token management, microcompaction, snip, auto-compact.
 * Ported from claude-vaz services/compact/ patterns.
 */
export { microcompact, type MicrocompactResult } from './microcompact'
export { autoCompact, compactNow, shouldAutoCompact, tokenCountWithEstimation, type AutoCompactResult, type AutoCompactTrackingState, type CompactFn } from './autoCompact'
export { applyToolResultBudget } from './toolResultBudget'
export { snipCompactIfNeeded, type SnipResult, type SnipOptions } from './snipCompact'
export { getCompactPrompt, formatCompactSummary, getCompactUserSummaryMessage } from './prompt'
