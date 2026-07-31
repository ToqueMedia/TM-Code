/**
 * Compact module — token management, microcompaction, snip, auto-compact.
 * Ported from claude-vaz services/compact/ patterns.
 */
export { microcompact, type MicrocompactResult } from './microcompact'
export { autoCompact, compactNow, shouldAutoCompact, tokenCountWithEstimation, resolveOccupancyWithSource, type AutoCompactResult, type AutoCompactTrackingState, type CompactFn, type OccupancySource } from './autoCompact'
export { applyToolResultBudget } from './toolResultBudget'
export { snipCompactIfNeeded, type SnipResult, type SnipOptions } from './snipCompact'
export { getCompactPrompt, formatCompactSummary, getCompactUserSummaryMessage } from './prompt'
