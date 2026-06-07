/**
 * Collapse module — persistent turn-summary projections for context management.
 * Ported from claude-vaz services/contextCollapse/ patterns.
 */
export {
  applyCollapsesIfNeeded,
  recoverFromOverflow,
  isContextCollapseEnabled,
  setContextCollapseEnabled,
  resetContextCollapse,
  withholdPromptTooLong,
  isWithheldPromptTooLong,
  stageCollapse,
  type CollapseResult,
} from './contextCollapse'
