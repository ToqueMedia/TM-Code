/**
 * Centralized post-compaction cleanup.
 *
 * After compaction, several module-level caches hold stale data that
 * predates the summary. This function sweeps them in one place so both
 * auto-compact and manual /compact paths behave identically.
 *
 * What IS cleared:
 * - Prompt cache (contextBuilder)
 * - Memory selector cache (memorySelector)
 * - Skill service cache (skillService)
 * - Scaffolding detector cache (scaffoldingDetector)
 * - Context collapse staged summaries (contextCollapse)
 *
 * What is NOT cleared (intentionally):
 * - Invoked skills (needed for post-compact re-injection of CRITICAL blocks)
 * - largeResults Map (still valid — content hasn't changed)
 * - fileAccessLog (still relevant for post-compact file re-reads)
 * - Session memory (survives compaction by design)
 */

import { logger } from '../../utils/logger'

export async function runPostCompactCleanup(): Promise<void> {
  // Resolve project path lazily — avoids requiring callers to pass it
  let projectPath: string | undefined
  try {
    const { useProjectStore } = await import('../../stores/projectStore')
    projectPath = useProjectStore.getState().currentProject?.path
  } catch { /* non-critical */ }

  // 1. Prompt cache — invalidate all (project filter unreliable post-compact)
  try {
    const ctxMod = await import('./contextBuilder')
    ctxMod.default.getInstance().invalidatePromptCache()
  } catch { /* non-critical */ }

  // 2. Memory selector cache
  try {
    const { invalidateMemorySelectorCache } = await import('./memorySelector')
    invalidateMemorySelectorCache()
  } catch { /* non-critical */ }

  // 3. Skill service cache
  try {
    const skillMod = await import('./skillService')
    skillMod.default.getInstance().invalidateCache()
  } catch { /* non-critical */ }

  // 4. Scaffolding detector cache (per-project)
  if (projectPath) {
    try {
      const { invalidateScaffoldingCache } = await import('../scaffoldingDetector')
      invalidateScaffoldingCache(projectPath)
    } catch { /* non-critical */ }
  }

  // 5. Context collapse — clear staged summaries (indices invalidated by compaction)
  try {
    const { resetContextCollapse } = await import('./collapse')
    resetContextCollapse()
  } catch { /* non-critical */ }

  logger.debug('agent', '[compact-cleanup] post-compact cache sweep complete')
}
