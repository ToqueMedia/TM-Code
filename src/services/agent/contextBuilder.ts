/**
 * ContextBuilder — system-prompt orchestrator.
 *
 * **Where the content lives** (May 2026 slice):
 *
 *   - Module-level helpers and constants  →  `contextBuilder/helpers.ts`
 *   - Shared types (PromptContext etc.)   →  `contextBuilder/types.ts`
 *   - File-tree / pkg / lang utilities    →  `contextBuilder/projectUtils.ts`
 *   - Shared snippets                     →  `contextBuilder/sections/sharedSections.ts`
 *   - Project prompt section builders     →  `contextBuilder/sections/chatSections.ts`
 *   - Cwd-scoped section builders         →  `contextBuilder/sections/cmdSections.ts`
 *
 * This file keeps the class itself: cache state, the public
 * `buildSystemPrompt` / `buildCmdModeSystemPrompt` entry points, and
 * `invalidatePromptCache`. Section content is composed by importing the
 * pure builder functions and concatenating them in the documented U-Curve
 * order (primacy → middle → recency). Re-exports preserve the legacy
 * import surface so existing call sites (and tests) keep working.
 */

import SkillService from './skillService'
import { logger } from '../../utils/logger'
import {
  CRITICAL_SECTIONS_MAX_BYTES,
  PROMPT_CACHE_TTL_MS,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  dynamicSection,
  extractCriticalSections,
  extractCriticalSectionsWithStats,
  sanitizeProjectContent as _sanitizeProjectContent,
  skillsFromHashtags,
  stablePromptHash,
  splitOnBoundary,
} from './contextBuilder/helpers'
import type {
  CmdPromptContext,
  MCPToolSummary,
  PackageSummary,
  PromptCacheEntry,
  PromptContext,
} from './contextBuilder/types'
import {
  buildFileTree,
  detectPackageManager,
  detectProjectType,
  detectProjectTypeFromFiles,
  extractPackageSummary,
  gatherGitContext,
  gatherRecentFiles,
  getLangInstruction,
  readPathAliases,
  readProjectManifest,
  readTemplateManifest,
  safeReadFile,
} from './contextBuilder/projectUtils'
import { buildProjectSymbolIndexSection } from './contextBuilder/projectSymbolIndex'
import {
  buildTmsSectionContext,
  isTmsSectionContextId,
  tmsSectionContextKeyFromId,
} from './contextBuilder/tmsSectionContext'
import {
  sharedContextPreservation,
  sharedIdentity,
  sharedMcpBlock,
  sharedMcpIndexBlock,
  sharedOutputEfficiency,
  sharedShellExecutionLoop,
  sharedToneAndStyle,
  sharedTurnEfficiency,
  sharedTasteDefaults,
  sharedUiBaselineCore,
} from './contextBuilder/sections/sharedSections'
import {
  getActivePlanSection,
  getHashtagSkillsSection,
  getBackgroundAgentsSection as getTeamSection,
  getBackgroundCommandsSection,
  getClosedLoopSection,
  getCompletionContractSection,
  getConstraintsSection,
  getDoingTasksSection,
  getScaffoldingInstallSection,
  getVisionSection,
  getDevServerRulesSection,
  getDevServerStatusSection,
  getEnvironmentSection,
  getExecutingActionsSection,
  getGitStatusSection,
  getRecentFilesSection,
  getMemoryGuidanceSection,
  getMemorySection,
  getMemoryToolsGuidanceSection,
  getModelSpecificSection,
  getPendingMemoryProposalsSection,
  getPreviewCompatibilitySection,
  getProjectMemorySection,
  getProjectStructureSection,
  getProjectStructureIndexSection,
  getReadmeSection,
  getReminderSection,
  getSessionMemorySection,
  getRoleSection,
  getSkillsSection,
  getSystemSection,
  getTaskListSection,
  getTemplateContextSection,
  getToolsSection,
  getTrackerStateSection,
} from './contextBuilder/sections/chatSections'
import {
  getCmdHashtagSkillsSection,
  getCmdClosedLoopSection,
  getCmdCompletionContractSection,
  getCmdConstraintsSection,
  getCmdDoingTasksSection,
  getCmdEnvironmentSection,
  getCmdExecutingActionsSection,
  getCmdGlobalMemorySection,
  getCmdLanguageReinforcementSection,
  getCmdMemorySection,
  getCmdMemoryToolsGuidanceSection,
  getCmdTmsContentSection,
  getCmdTmsGuidanceSection,
  getCmdReminderSection,
  getCmdSessionMemorySection,
  getCmdRoleSection,
  getCmdSecuritySection,
  getCmdSessionGuidanceSection,
  getCmdSkillsSection,
  getCmdSystemSection,
  getCmdToolsSection,
} from './contextBuilder/sections/cmdSections'

import { ContextPlannerError, planContextWithModel } from './contextPlanner'
import {
  classifyPromptIntent,
  selectAuxiliaries,
  buildOnDemandIndex,
  getAuxiliaryMeta,
  resolveAuxiliaryId,
  type AuxiliarySelection,
  type PromptProfile,
  type RouterDiagnostics,
} from './contextBuilder/auxiliaryRegistry'
import { getTmsTurnTelemetry, markProjectSymbolIndexRequested } from './tmsContext'

type IntentOverride = {
  profile: PromptProfile
  readOnly: boolean
  requiresMutation?: boolean
  reason?: string
  source?: 'model' | 'fallback' | 'keyword'
  confidence?: 'high' | 'medium' | 'low' | 'none'
  error?: string
  diagnostics?: RouterDiagnostics
}

// ── Re-exports — keep the legacy import surface so external callers (tests,
// other services) don't have to update their import paths after the slice. ──

export {
  CRITICAL_SECTIONS_MAX_BYTES,
  extractCriticalSections,
  extractCriticalSectionsWithStats,
  skillsFromHashtags,
}
export type { PromptContext, CmdPromptContext, MCPToolSummary, PackageSummary }

/**
 * Helper for cwd-scoped memory index loading. Loads the MEMORY.md index
 * and mtime map in parallel, checks for stale entries.
 * Consolidates the two identical IIFEs that were previously inline.
 */
async function loadCmdMemoryIndex(
  scope: 'user' | 'project',
  projectPath?: string,
): Promise<{ content: string | null; hasStale: boolean }> {
  try {
    const { loadMemoryIndex, loadMemoryMtimes } = await import('./memdir')
    const { isMemoryStale } = await import('./memoryAge')
    const [result, mtimes] = await Promise.all([
      loadMemoryIndex(scope, projectPath),
      loadMemoryMtimes(scope, projectPath),
    ])
    if (result.content) {
      const hasStale = Array.from(mtimes.values()).some(m => isMemoryStale(m))
      return { content: result.content, hasStale }
    }
    return { content: null, hasStale: false }
  } catch { return { content: null, hasStale: false } }
}

class ContextBuilder {
  private static instance: ContextBuilder
  private promptCache = new Map<string, PromptCacheEntry>()

  // ── Auxiliary context selection (on-demand architecture) ──
  // Set during buildSystemPrompt / buildCmdModeSystemPrompt. Read by:
  //   - payloadInspector (core/auxiliary token split + loaded/omitted)
  //   - the `request_context` meta-tool handler in agentService (loads an
  //     omitted auxiliary's content on demand mid-run).
  // Single-active-run assumption: one agent loop per session drives the build;
  // the value is overwritten on each build. Safe because the loop is single-
  // threaded per session.
  private lastAuxiliarySelection: AuxiliarySelection | null = null
  private lastAuxiliaryCtx: {
    pmDetected: string
    isVanillaWeb: boolean
    promptCtx?: PromptContext
    loadedSkills?: import('./skillService').Skill[]
  } | null = null

  /** The auxiliary selection from the most recent prompt build (or null). */
  getLastAuxiliarySelection(): AuxiliarySelection | null {
    return this.lastAuxiliarySelection
  }

  private recordRequestContextAttempt(id: string, loaded: boolean): void {
    const sel = this.lastAuxiliarySelection
    if (!sel) return
    const resolvedId = resolveAuxiliaryId(id)
    const meta = getAuxiliaryMeta(resolvedId)

    sel.requestContextToolCalls = (sel.requestContextToolCalls ?? 0) + 1
    sel.modelRequestedContextSections ??= []
    if (!sel.modelRequestedContextSections.includes(resolvedId)) {
      sel.modelRequestedContextSections.push(resolvedId)
    }

    const target = loaded ? 'requestContextSectionsLoaded' : 'requestedButNotLoadedSections'
    sel[target] ??= []
    if (!sel[target]!.includes(resolvedId)) {
      sel[target]!.push(resolvedId)
    }

    sel.requestContextSelectionReason ??= {}
    sel.requestContextSelectionReason[resolvedId] = meta
      ? `${loaded ? 'loaded' : 'not loaded'} ${meta.domain}/${meta.capability}; ${meta.whenToUse}`
      : `${loaded ? 'loaded' : 'not loaded'} unknown context`
    sel.requestContextCostTier ??= {}
    if (meta) sel.requestContextCostTier[resolvedId] = meta.costTier

    const selected = new Set(sel.contextPlan.selectedContexts.map(resolveAuxiliaryId))
    const isFallback = Boolean(meta && !selected.has(resolvedId) && (
      meta.granularity === 'full' ||
      meta.costTier === 'high' ||
      meta.id === 'project.structure_overview' ||
      meta.id === 'project.structure_full'
    ))
    if (loaded && isFallback) {
      sel.requestContextFallbackUsed = true
      sel.requestContextFallbackFrom ??= []
      sel.requestContextFallbackTo ??= []
      const from = sel.contextPlan.selectedContexts.map(resolveAuxiliaryId)
      for (const source of from) {
        if (!sel.requestContextFallbackFrom.includes(source)) sel.requestContextFallbackFrom.push(source)
      }
      if (!sel.requestContextFallbackTo.includes(resolvedId)) sel.requestContextFallbackTo.push(resolvedId)
    }
  }

  private async renderAuxiliaryContent(id: string): Promise<string | null> {
    const ctx = this.lastAuxiliaryCtx
    const resolvedId = resolveAuxiliaryId(id)
    if (isTmsSectionContextId(resolvedId)) {
      const key = tmsSectionContextKeyFromId(resolvedId)
      return key && ctx?.promptCtx ? buildTmsSectionContext(ctx.promptCtx.tmsContent, key) : null
    }
    switch (resolvedId) {
      case 'scaffold.workflow':
        return ctx ? getScaffoldingInstallSection({ pmDetected: ctx.pmDetected }) : null
      case 'vision.image_rules':
        return getVisionSection()
      case 'design_system.semantic_tokens':
        return [
          '# Design system: semantic tokens',
          'Use for token/theme work only. Start by locating existing semantic token/theme files before editing.',
          'Expected files: src/theme/**/semantic*, src/theme/**/tokens*, src/themes/**, src/theme/index.ts.',
          'Prefer adding the smallest semantic alias that matches existing naming. Do not load project.structure_full for token work unless the expected files cannot be located with search/list/read tools.',
        ].join('\n')
      case 'design_system.theme_config':
        return [
          '# Design system: theme configuration',
          'Use for theme entrypoints, Chakra/System config, provider wiring, and semantic token registration.',
          'Expected files: src/theme/index.ts, src/theme/**, src/themes/**, src/components/ui/provider.tsx.',
          'Read the theme entrypoint and the specific token file before editing.',
        ].join('\n')
      case 'design_system.brand_palette':
        return [
          '# Design system: brand palette',
          'Use for palette/color token naming, semantic color aliases, and contrast-aware palette decisions.',
          'Expected files: src/theme/**/colors*, src/theme/**/tokens*, src/themes/**.',
        ].join('\n')
      case 'design_system.chakra_recipes':
        return [
          '# Design system: Chakra recipes',
          'Use for Chakra recipes, slot recipes, variants, and reusable component styling.',
          'Expected files: src/theme/**/recipes*, src/theme/**/slot-recipes*, src/components/ui/**.',
        ].join('\n')
      case 'design_system.component_patterns':
        return sharedUiBaselineCore()
      case 'ui_patterns':
        return sharedTasteDefaults()
      case 'project.structure_overview':
        return ctx?.promptCtx ? getProjectStructureIndexSection(ctx.promptCtx) : null
      case 'project.package_map':
        if (!ctx?.promptCtx) return null
        return [
          '# Project package map',
          `project type: ${ctx.promptCtx.projectType}`,
          `package manager: ${ctx.promptCtx.pmDetected}`,
          ctx.promptCtx.pkgSummary ? `package summary:\n${ctx.promptCtx.pkgSummary}` : 'package summary: unavailable',
          ctx.promptCtx.pathAliases.length ? `path aliases:\n${ctx.promptCtx.pathAliases.map(a => `- ${a}`).join('\n')}` : null,
        ].filter(Boolean).join('\n')
      case 'project.entrypoints':
        if (!ctx?.promptCtx) return null
        return [
          '# Project entrypoints',
          'Expected entrypoint candidates: src/main.tsx, src/App.tsx, src/index.ts, src/routes/**, vite.config.*, tauri command modules.',
          ctx.promptCtx.pathAliases.length ? `path aliases:\n${ctx.promptCtx.pathAliases.map(a => `- ${a}`).join('\n')}` : null,
          'Use search/list/read tools to confirm the exact entrypoint before editing.',
        ].filter(Boolean).join('\n')
      case 'project.symbol_index':
        if (!ctx?.promptCtx) return null
        return buildProjectSymbolIndexSection(ctx.promptCtx.projectPath)
      case 'project.structure_full':
        return ctx?.promptCtx ? getProjectStructureSection(ctx.promptCtx) : null
      case 'agent_runtime.mcp_routing':
        return ctx?.promptCtx ? sharedMcpBlock(ctx.promptCtx.mcpTools, 'developer') : null
      case 'agent_runtime.tool_profiles':
        return [
          '# Agent runtime: tool profiles',
          'Tool profiles choose the starter toolset for the current task. They do not cap what can be loaded later.',
          'Use request_tools whenever the current active set lacks a required capability; a registered tool should be delivered on demand unless an explicit no-edit/read-only policy blocks it.',
          'Expected files: src/services/agent/toolsetSelector.ts and callers that pass selectedPromptProfile.',
        ].join('\n')
      case 'agent_runtime.request_context_policy':
        return [
          '# Agent runtime: request_context policy',
          'Choose the smallest sufficient context: capability-specific > domain summary > project overview > full project tree.',
          'When locating functions, classes, components, hooks, handlers, stores, providers, or services, request project.symbol_index before broad project structure.',
          'Use project.structure_full only after specific contexts fail, files are unknown, architecture is broad, or dependency mapping spans areas.',
          'Expected files: src/services/agent/contextBuilder/auxiliaryRegistry.ts, src/services/agent/contextBuilder.ts, src/services/agent/payloadInspector.ts.',
        ].join('\n')
      case 'agent_runtime.memory_context':
        if (!ctx?.promptCtx) return null
        return [
          getMemorySection(ctx.promptCtx),
          getProjectMemorySection(ctx.promptCtx),
          getSessionMemorySection(ctx.promptCtx),
          getMemoryToolsGuidanceSection(),
        ].filter(Boolean).join('\n\n') || null
      case 'delivery.dev_server':
        return [getDevServerRulesSection(), getDevServerStatusSection()].filter(Boolean).join('\n\n')
      case 'delivery.build_scripts':
        if (!ctx?.promptCtx) return null
        return [
          '# Delivery: build scripts',
          `package manager: ${ctx.promptCtx.pmDetected}`,
          ctx.promptCtx.pkgSummary ? `package summary:\n${ctx.promptCtx.pkgSummary}` : 'package summary: unavailable',
          'Use for build/test/dev command discovery before broader project structure.',
        ].join('\n')
      case 'delivery.git_status':
        return ctx?.promptCtx ? getGitStatusSection(ctx.promptCtx) : null
      case 'delivery.changed_files':
        return ctx?.promptCtx ? getRecentFilesSection(ctx.promptCtx) : null
      case 'project.docs_full':
        if (ctx?.promptCtx) {
          const parts = [
            ctx.promptCtx.readme ? `# README.md\n${ctx.promptCtx.readme}` : null,
            ctx.promptCtx.tmsContent ? `# TMS.md\n${ctx.promptCtx.tmsContent}` : null,
            ctx.promptCtx.planContent ? `# PLAN.md\n${ctx.promptCtx.planContent}` : null,
            ctx.promptCtx.todoContent ? `# TODO.md\n${ctx.promptCtx.todoContent}` : null,
          ].filter(Boolean) as string[]
          return parts.length ? parts.join('\n\n') : null
        }
        return null
      default:
        return null
    }
  }

  /**
   * Load an omitted auxiliary's full content on demand. Called by the
   * `request_context` tool handler when the agent asks for a section that was
   * omitted from the system prompt. Returns null for unknown ids or
   * already-loaded auxiliaries (no-op — the content is already inline).
   */
  async loadAuxiliaryOnDemand(id: string): Promise<{ content: string | null; name: string }> {
    const sel = this.lastAuxiliarySelection
    if (!sel) return { content: null, name: id }
    const resolvedId = resolveAuxiliaryId(id)
    // Already loaded inline → nothing to fetch.
    if (sel.loaded.some((l) => l.id === resolvedId)) {
      this.recordRequestContextAttempt(resolvedId, false)
      return { content: null, name: resolvedId }
    }
    const content = await this.renderAuxiliaryContent(resolvedId)
    const meta = sel.omitted.find((o) => o.id === resolvedId) ?? getAuxiliaryMeta(resolvedId)
    if (content) {
      this.recordRequestContextAttempt(resolvedId, true)
    } else {
      this.recordRequestContextAttempt(resolvedId, false)
    }
    return { content, name: meta?.name ?? resolvedId }
  }

  static getInstance(): ContextBuilder {
    if (!ContextBuilder.instance) {
      ContextBuilder.instance = new ContextBuilder()
    }
    return ContextBuilder.instance
  }

  /**
   * Invalidate cached prompts for a project (or all projects if omitted).
   * Call after write operations that touch README.md, TMS.md, PLAN.md, TODO.md,
   * package.json, .toquemedia/project.json, .toquemedia-template, or
   * .toquemedia-id. The last one matters:
   * if the agent writes .toquemedia-id mid-session (standardization pass), the
   * next prompt must reflect tm_code_owned=true, not the cached false.
   */
  /**
   * Load persistent memory indexes, optionally filter via the per-plan
   * selector, and report whether any surviving entry is stale.
   *
   * Extracted from `buildSystemPrompt` so it can be started as a Promise
   * at the top of the prompt build and awaited at the section render
   * point — the selector model call (~300-600 ms) then overlaps with
   * disk reads, git context gathering, etc. instead of serialising on
   * the critical path.
   *
   * Failure path returns the inject-all fallback (`null` indexes when
   * the disk reads themselves fail; full indexes when the selector
   * fails). The agent loop is never blocked by a broken memory layer.
   */
  private async runMemoryWork(
    projectPath: string,
    userMessage?: string,
    accessedPaths?: string[],
  ): Promise<{
    userMemoryIndex: string | null
    projectMemoryIndex: string | null
    memoryHasStale: boolean
  }> {
    let userMemoryIndex: string | null = null
    let projectMemoryIndex: string | null = null
    let memoryHasStale = false
    try {
      const {
        loadMemoryIndex,
        loadMemoryMtimes,
        parseIndexEntries,
        projectIndexEntries,
      } = await import('./memdir')
      // Index + mtimes loaded in parallel — mtimes is a cheap readdir+stat
      // per scope and runs alongside the index reads without adding latency.
      const [userResult, projectResult, userMtimes, projectMtimes] = await Promise.all([
        loadMemoryIndex('user'),
        loadMemoryIndex('project', projectPath),
        loadMemoryMtimes('user'),
        loadMemoryMtimes('project', projectPath),
      ])
      userMemoryIndex = userResult.content
      projectMemoryIndex = projectResult.content

      const combinedBytes = (userResult.byteCount || 0) + (projectResult.byteCount || 0)
      const { MEMORY_SELECTOR_THRESHOLD_BYTES } = await import('./memorySelector')
      if (userMessage && combinedBytes > MEMORY_SELECTOR_THRESHOLD_BYTES) {
        const userEntries = userMemoryIndex ? parseIndexEntries(userMemoryIndex, userMtimes) : []
        const projectEntries = projectMemoryIndex ? parseIndexEntries(projectMemoryIndex, projectMtimes) : []
        let allEntries = [...userEntries, ...projectEntries]

        // Path-scoped filtering: remove entries whose `paths` don't match
        // any file the agent has accessed this session. Entries without
        // `paths` are always active (backward compatible).
        if (accessedPaths && accessedPaths.length > 0) {
          const { matchesAccessedPaths } = await import('./memdir')
          allEntries = allEntries.filter(e => matchesAccessedPaths(e.paths, accessedPaths))
        }

        if (allEntries.length > 0) {
          const { selectRelevantMemories } = await import('./memorySelector')
          const { useChatStore } = await import('../../stores/chatStore')
          const sessionId = useChatStore.getState().activeSessionId || 'no-session'
          const selection = await selectRelevantMemories({
            sessionId,
            userMessage,
            entries: allEntries.map(e => ({
              name: e.name,
              type: e.type,
              description: e.description,
              mtimeMs: e.mtimeMs,
            })),
          })
          if (selection) {
            // Project each scope's index down to selected entries. The
            // selector's set is global — userMemoryIndex keeps only its
            // user/feedback rows that survived, projectMemoryIndex keeps
            // only its project/reference rows. If a scope ends up empty
            // after projection, the section render drops it.
            if (userMemoryIndex) {
              const projected = projectIndexEntries(userMemoryIndex, selection.selectedNames)
              userMemoryIndex = parseIndexEntries(projected).length > 0 ? projected : null
            }
            if (projectMemoryIndex) {
              const projected = projectIndexEntries(projectMemoryIndex, selection.selectedNames)
              projectMemoryIndex = parseIndexEntries(projected).length > 0 ? projected : null
            }

            void import('../../services/analytics').then(({ trackEvent }) =>
              trackEvent('memory_selector_run', {
                cache_hit: selection.cacheHit,
                latency_ms: selection.latencyMs,
                items_total: allEntries.length,
                items_selected: selection.selectedNames.size,
                combined_bytes_before: combinedBytes,
              }),
            ).catch(() => { /* analytics never blocks prompt build */ })
          }
        }
      }

      // memoryHasStale: section-level header flips into "verify before
      // recommending" mode when at least one visible entry is past the
      // stale threshold. Per-entry inline annotation was removed —
      // duplicated the age already passed to the selector model. The
      // section header is the single freshness signal in the slice.
      const { isMemoryStale } = await import('./memoryAge')
      const survivingFilenames = new Set<string>()
      if (userMemoryIndex) {
        for (const e of parseIndexEntries(userMemoryIndex)) survivingFilenames.add(e.filename)
      }
      if (projectMemoryIndex) {
        for (const e of parseIndexEntries(projectMemoryIndex)) survivingFilenames.add(e.filename)
      }
      for (const filename of survivingFilenames) {
        const mtimeMs = userMtimes.get(filename) ?? projectMtimes.get(filename) ?? 0
        if (isMemoryStale(mtimeMs)) {
          memoryHasStale = true
          break
        }
      }
    } catch { /* memdir is best-effort, prompt builds fine without it */ }
    return { userMemoryIndex, projectMemoryIndex, memoryHasStale }
  }

  invalidatePromptCache(projectPath?: string): void {
    if (!projectPath) {
      this.promptCache.clear()
      return
    }
    for (const key of this.promptCache.keys()) {
      if (key.startsWith(`${projectPath}|`)) this.promptCache.delete(key)
    }
  }

  async buildSystemPrompt(projectPath: string, projectType: string, mcpTools?: MCPToolSummary[], coreToolCount?: number, userMessage?: string, accessedPaths?: string[], intentOverride?: IntentOverride): Promise<string> {
    // Cache key must include everything that affects the prompt shape.
    // Plan is read below; include it in the key so plan switches bypass the cache.
    let planKey = 'unknown'
    try {
      const { useBillingStore } = await import('../../stores/billingStore')
      planKey = useBillingStore.getState().plan || 'unknown'
    } catch { /* non-critical */ }
    // agentLanguage affects the language instruction embedded in the Role
    // section — omitting it from the cache key made language changes take
    // up to 30s (TTL) to surface, and the conversation history bias kept
    // pushing the old language even after the cache rebuilt.
    let agentLangKey = 'en'
    try {
      const { useSettingsStore } = await import('../../stores/settingsStore')
      agentLangKey = useSettingsStore.getState().agentLanguage || 'en'
    } catch { /* non-critical */ }
    const mcpSig = (mcpTools ?? []).map(t => `${t.serverName}:${t.name}`).sort().join(',')
    // Hashtag-driven sticky must invalidate cache when the set of recognised
    // tags changes — same conversation but the user just typed `#design`
    // for the first time should re-render with the design skill inlined.
    const stickyHashtagSkills = skillsFromHashtags(userMessage)
    const stickyHashtagSig = stickyHashtagSkills.slice().sort().join(',')
    // fsVersion is a path-agnostic filesystem fingerprint — incremented on
    // every observed write. Including it in the key guarantees the cache
    // misses after ANY mutation, so the next turn sees the real file tree
    // even when the previous turn created files (the regression where
    // `helper.ts` written in turn 1 was missing from turn 2's tree until
    // the 30s TTL expired). Replaces the prior path-suffix regex in
    // toolExecutor — that approach silently broke as soon as a new write
    // path landed without matching the regex.
    const { getFsVersion } = await import('../fsVersion')
    const fsVersion = getFsVersion()
    // Include accessedPaths count in cache key — without this, path-scoped
    // memory filtering is stale when only reads (not writes) occur between
    // turns, since reads don't increment fsVersion.
    const accessedCount = accessedPaths?.length ?? 0
    // ── Auxiliary context selection (on-demand architecture) ──
    // Intent Router supplies profile/readOnly. Context Planner (utility model)
    // supplies the actual domain/capability plan and initial tool groups. The
    // planner is model-owned: utility sidecar retries first, then the code
    // model. If both fail, do not block the main agent: continue without
    // preloaded auxiliary context and let the primary model request context
    // on demand. This fallback deliberately does not inspect the user text or
    // choose a semantic domain.
    const auxProfile = intentOverride?.profile ?? classifyPromptIntent(userMessage, {
      mentionedFiles: accessedPaths,
    })
    const readOnly = intentOverride?.readOnly ?? false
    const requiresMutation = !readOnly && intentOverride?.requiresMutation === true
    let contextPlan: Awaited<ReturnType<typeof planContextWithModel>>
    let plannerFailure: ContextPlannerError | null = null
    try {
      contextPlan = await planContextWithModel(userMessage ?? '', auxProfile, readOnly)
    } catch (err) {
      if (err instanceof ContextPlannerError) {
        plannerFailure = err
        logger.warn('context-builder', 'context planner failed; continuing without preloaded auxiliary context', {
          error: err.message,
          fallbackReason: err.fallbackReason,
          diagnostics: err.diagnostics,
          rawOutput: err.rawOutput?.slice(0, 500),
        })
        contextPlan = {
          plan: {
            taskDomain: `${auxProfile}.planner_unavailable`,
            requiredCapabilities: [],
            minimumContextNeeded: 'index',
            candidateContexts: [],
            selectedContexts: [],
            rejectedContexts: [],
            toolGroups: readOnly ? [] : ['FILE_OPS'],
            fallbackRisk: 'medium',
            reason: 'Context planner failed after model retries; no auxiliary context was preloaded. The primary agent must request context on demand.',
          },
          source: 'fallback',
          confidence: 'none',
          reason: 'planner unavailable; delegated context selection to primary agent',
          error: err.message,
          fallbackReason: err.fallbackReason,
          diagnostics: err.diagnostics,
        }
      } else {
        throw err
      }
    }
    const plannerReason = `${contextPlan.source === 'model' ? 'model context planner' : 'context planner fallback'}: ${contextPlan.reason}`
    const auxSelection = selectAuxiliaries(
      auxProfile,
      userMessage,
      readOnly,
      intentOverride?.reason ? `${intentOverride.reason}; ${plannerReason}` : plannerReason,
      intentOverride?.source ? { source: intentOverride.source, confidence: intentOverride.confidence, error: intentOverride.error, diagnostics: intentOverride.diagnostics } : undefined,
      contextPlan.plan,
      {
        status: contextPlan.source === 'model' ? 'parsed' : 'fallback',
        source: contextPlan.source,
        modelTier: contextPlan.modelTier,
        error: contextPlan.error ?? plannerFailure?.message,
        rawOutput: contextPlan.diagnostics?.contentPreview ?? contextPlan.diagnostics?.rawBodyPreview ?? plannerFailure?.rawOutput?.slice(0, 500),
        fallbackReason: contextPlan.fallbackReason,
        selectionReason: contextPlan.reason,
      },
      requiresMutation,
    )
    this.lastAuxiliarySelection = auxSelection
    const contextPlanSig = [
      auxSelection.contextPlan.taskDomain,
      auxSelection.contextPlan.selectedContexts.join(','),
      auxSelection.contextPlan.candidateContexts.join(','),
      auxSelection.contextPlan.toolGroups?.join(',') ?? '',
    ].join('|')
    const cacheKeyBase = `${projectPath}|${projectType}|${coreToolCount ?? 20}|${planKey}|${agentLangKey}|${mcpSig}|${stickyHashtagSig}|fs${fsVersion}|ac${accessedCount}|p${auxProfile}|ro${auxSelection.readOnly ? 1 : 0}|mut${auxSelection.requiresMutation ? 1 : 0}|cp${contextPlanSig}`

    const now = Date.now()
    // Kick off memory work IMMEDIATELY so its network call (selector
    // model side-car, ~300-600 ms) overlaps with everything else this
    // function does: disk I/O, git context gathering, MCP refresh,
    // skill load, even the cmdMode branch above us in the call stack.
    // The result is awaited at the section render point below. Previous
    // shape (Promise.all of disk reads, THEN memory work, THEN render)
    // serialised the selector latency on the critical path; now it
    // hides behind whichever I/O happens to be slowest.
    const memoryWorkPromise = this.runMemoryWork(projectPath, userMessage, accessedPaths)

    // Gather context in parallel for speed
    const [treeString, pkgSummary, readme, projectManifest, templateManifest, tmsContent, planContent, todoContent, toquemediaIdRaw, gitContext, recentFiles, pathAliases] = await Promise.all([
      buildFileTree(projectPath),
      extractPackageSummary(projectPath),
      safeReadFile(`${projectPath}/README.md`),
      readProjectManifest(projectPath),
      readTemplateManifest(projectPath),
      safeReadFile(`${projectPath}/TMS.md`),
      safeReadFile(`${projectPath}/PLAN.md`),
      safeReadFile(`${projectPath}/TODO.md`),
      safeReadFile(`${projectPath}/.toquemedia-id`),
      gatherGitContext(projectPath),
      gatherRecentFiles(projectPath),
      readPathAliases(projectPath),
    ])
    // Any non-null content means the marker exists. We don't care about the ID
    // itself for prompt decisions — only whether TM Code authored the project.
    const tmCodeOwned = toquemediaIdRaw !== null

    const pmDetected = pkgSummary?.packageManager || await detectPackageManager(projectPath)
    const isTemplateProject = templateManifest !== null
    const hasFrameworkDeps = pkgSummary
      ? [...pkgSummary.dependencies, ...pkgSummary.devDependencies].some(d =>
          ['react', 'next', 'vue', 'nuxt', 'svelte', '@angular/core', 'astro', 'solid-js', 'express', 'fastify', '@nestjs/core'].includes(d)
        )
      : false
    const isVanillaWeb = !isTemplateProject && !hasFrameworkDeps

    // Language
    const langInstruction = await getLangInstruction()

    // Load model profile for model-specific behavior
    let modelProfile: import('./modelProfiles').ModelProfile | null = null
    try {
      const { getProfileForPlan, MODEL_PROFILES } = await import('./modelProfiles')
      const { useBillingStore } = await import('../../stores/billingStore')
      const { useAgentStore } = await import('../../stores/agentStore')
      const modelName = useAgentStore.getState().modelName
      const plan = useBillingStore.getState().plan
      modelProfile = modelName && MODEL_PROFILES[modelName] ? MODEL_PROFILES[modelName] : getProfileForPlan(plan)
    } catch { /* fallback: no profile */ }

    // ═══════════════════════════════════════════════════════════════
    // SYSTEM PROMPT — composable assembly. Each section is a pure
    // function that returns `string | null` (null = skip). Order below
    // is the U-Curve:
    //   primacy:  completion contract → role → identity
    //   middle:   system, tasks, actions, closed-loop, tools, MCP,
    //             environment, project content, skills, constraints
    //   recency:  tone, output efficiency, context preservation, reminder
    // ═══════════════════════════════════════════════════════════════
    // Load skills upfront so both getSkillsSection and getReminderSection see
    // the same list — the reminder cites them by name in the recency window
    // to defeat the U-curve middle-dip on the skill index itself.
    let loadedSkills: import('./skillService').Skill[] = []
    try {
      const detectedType = detectProjectType(pkgSummary) ?? await detectProjectTypeFromFiles(projectPath)
      loadedSkills = await SkillService.getInstance().loadSkills(projectPath, detectedType, 'chat')
    } catch { /* non-critical */ }

    // Snapshot the live task tracker so the prompt has a deterministic
    // "what's done / what's next" view. This is the fix for the post-budget-
    // interrupt failure where the agent inferred completion from the
    // filesystem and batch-completed N tasks with one write — see
    // `getTrackerStateSection` for the steering rules attached.
    let currentTasks: PromptContext['currentTasks'] = []
    try {
      const { useAgentStore } = await import('../../stores/agentStore')
      currentTasks = useAgentStore.getState().tasks.map(t => ({
        id: t.id,
        description: t.description,
        status: t.status,
        dependsOn: t.dependsOn ?? [],
        blockedBy: t.blockedBy ?? [],
        files: t.files ?? [],
      }))
    } catch { /* non-critical */ }

    // Persistent memory work was kicked off at the top of this function
    // so its network call (selector model) overlaps with the disk reads
    // above. Now that we need the result, await it.
    const { userMemoryIndex, projectMemoryIndex, memoryHasStale } = await memoryWorkPromise

    // Pending memory proposals — surfaced as a system reminder when the
    // post-turn extractor identified facts worth saving in a prior turn
    // and the agent hasn't yet acted on them. Lives in the dynamic block
    // (changes between turns as proposals are added / saved / expire).
    let pendingMemoryProposals: string | null = null
    try {
      const { buildProposalsReminder } = await import('./memoryProposalsStore')
      pendingMemoryProposals = await buildProposalsReminder(projectPath)
    } catch { /* non-critical */ }

    // Session memory — agent-maintained notes that survive compaction.
    // Loaded from the active chat session (piggybacks on session persistence).
    let sessionMemory: string | null = null
    try {
      const { useChatStore } = await import('../../stores/chatStore')
      sessionMemory = useChatStore.getState().getActiveSession()?.sessionMemory ?? null
    } catch { /* non-critical */ }

    const ctx: PromptContext = {
      projectPath,
      normalizedProjectPath: projectPath.replace(/\\/g, '/'),
      projectType,
      tmCodeOwned,
      pmDetected,
      isVanillaWeb,
      pkgSummary,
      treeString,
      gitContext,
      recentFiles,
      pathAliases,
      readme,
      tmsContent,
      planContent,
      todoContent,
      projectManifest,
      templateManifest,
      langInstruction,
      modelProfile,
      mcpTools: mcpTools || [],
      coreToolCount: coreToolCount ?? 20,
      loadedSkillNames: loadedSkills.map(s => s.name),
      hashtagSkills: stickyHashtagSkills,
      currentTasks,
      userMemoryIndex,
      projectMemoryIndex,
      memoryHasStale,
      pendingMemoryProposals,
      sessionMemory,
      accessedFilePaths: accessedPaths,
    }

    // Resolve the async team section once so dynamicSection()
    // can stay synchronous below — the wrapper exists to enforce a
    // declarative `(name, body, reason)` shape, not to host the async I/O.
    const teamSection = await getTeamSection()
    const bgCommandsSection = await getBackgroundCommandsSection()

    // ── Load auxiliary content for the selected auxiliaries ──
    // The selection (metadata) was computed before the cache key; the actual
    // CONTENT is loaded here because the scaffolding/install loader needs
    // ctx.pmDetected (only available after the parallel gather). Auxiliaries
    // that are omitted stay unloaded — their ids appear in the on-demand
    // index below, and the agent can fetch them via `request_context`.
    this.lastAuxiliaryCtx = { pmDetected: ctx.pmDetected, isVanillaWeb: ctx.isVanillaWeb, promptCtx: ctx, loadedSkills }
    const auxLoadedContent: Record<string, string> = {}
    for (const l of auxSelection.loaded) {
      const body = await this.renderAuxiliaryContent(l.id)
      if (body) auxLoadedContent[l.id] = body
    }
    const onDemandIndex = buildOnDemandIndex(auxSelection)
    const dynamicCacheSig = stablePromptHash(JSON.stringify({
      userMessage: userMessage ?? '',
      accessedPaths: accessedPaths ?? [],
      treeString,
      pkgSummary,
      readme,
      projectManifest,
      templateManifest,
      tmsContent,
      planContent,
      todoContent,
      toquemediaIdRaw,
      gitContext,
      recentFiles,
      pathAliases,
      pmDetected,
      isTemplateProject,
      isVanillaWeb,
      loadedSkillNames: loadedSkills.map(s => s.name),
      currentTasks,
      userMemoryIndex,
      projectMemoryIndex,
      memoryHasStale,
      pendingMemoryProposals,
      sessionMemory,
      teamSection,
      bgCommandsSection,
      auxLoadedContent,
      onDemandIndex,
    }))
    const cacheKey = `${cacheKeyBase}|dyn${dynamicCacheSig}`
    const cached = this.promptCache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      // Cache hits are allowed only after per-turn inputs have been gathered
      // and hashed. Returning earlier risks serving stale memory, tracker, or
      // session state even though those sections live below the dynamic marker.
      emitPromptBuiltTelemetry({
        mode: 'chat',
        cacheHit: true,
        prompt: cached.prompt,
        plan: planKey,
        agentLang: agentLangKey,
        fsVersion,
        mcpToolCount: (mcpTools ?? []).length,
        loadedSkillNames: ctx.loadedSkillNames,
      })
      if (cached.symbolIndexTelemetry) {
        markProjectSymbolIndexRequested(cached.symbolIndexTelemetry)
      }
      return cached.prompt
    }

    const sections = [
      // ── Static block (cacheable cross-session) ──────────────────
      getCompletionContractSection(),
      getRoleSection(ctx),
      sharedIdentity(),
      getModelSpecificSection(ctx),
      getSystemSection(),
      getDoingTasksSection(ctx),
      getExecutingActionsSection(),
      sharedShellExecutionLoop('chat'),
      getClosedLoopSection(),
      getToolsSection(ctx),
      getConstraintsSection(ctx),
      sharedToneAndStyle(),
      sharedOutputEfficiency(),
      sharedContextPreservation(),
      sharedTurnEfficiency(),
      // Memory taxonomy + save/forget discipline. The rules of the
      // memory system are stable across sessions (the data on disk
      // mutates, but the schema/contract is fixed), so this guidance
      // lives in the static block. The actual memory CONTENT is injected
      // below the boundary via getMemorySection.
      getMemoryToolsGuidanceSection(),
      // On-demand auxiliary index — lists context blocks omitted from this
      // prompt so the agent can fetch them via `request_context`. Null when
      // nothing is omitted (no index rendered). Stable per-intent-profile
      // so it's safe in the cacheable static block.
      onDemandIndex ?? '',
      // ── Boundary: everything below varies per session / per turn ──
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      // Persistent memory — placed first in the dynamic block because it's
      // the most authoritative per-session context (cross-session facts the
      // developer established). Below the cache boundary because the indexes
      // mutate when the model saves/forgets memories mid-session, so static-
      // caching them would serve stale content.
      dynamicSection('scaffold_workflow', () => auxLoadedContent['scaffold.workflow'] ?? null,
        'scaffold workflow auxiliary is selected only for project-bootstrap tasks'),
      dynamicSection('additional_constraints', () => [
        auxLoadedContent['vision.image_rules'] ?? '',
        auxLoadedContent['delivery.dev_server'] ?? '',
      ].filter(Boolean).join('\n\n') || null,
        'constraint auxiliaries are selected per intent/project and may be absent'),
      dynamicSection('design_system_semantic_tokens', () => auxLoadedContent['design_system.semantic_tokens'] ?? null,
        'design-system auxiliary is selected per intent/project and may be absent'),
      dynamicSection('design_system_theme_config', () => auxLoadedContent['design_system.theme_config'] ?? null,
        'theme auxiliary is selected per intent/project and may be absent'),
      dynamicSection('design_system_brand_palette', () => auxLoadedContent['design_system.brand_palette'] ?? null,
        'brand palette auxiliary is selected per intent/project and may be absent'),
      dynamicSection('design_system_chakra_recipes', () => auxLoadedContent['design_system.chakra_recipes'] ?? null,
        'Chakra recipe auxiliary is selected per intent/project and may be absent'),
      dynamicSection('design_system_component_patterns', () => auxLoadedContent['design_system.component_patterns'] ?? null,
        'component pattern auxiliary is selected per intent/project and may be absent'),
      dynamicSection('ui_patterns', () => auxLoadedContent['ui_patterns'] ?? null,
        'UI pattern auxiliary is selected per intent/project and may be absent'),
      dynamicSection('memory', () => getMemorySection(ctx),
        'MEMORY.md indexes mutate as save_memory / forget_memory run'),
      // Pending auto-extracted proposals — surfaced AFTER the existing
      // memory section so the agent reads what's already saved first,
      // then decides which proposals add real new information vs duplicate
      // what's there. Mutates on every post-turn extractor run.
      dynamicSection('memory_proposals', () => getPendingMemoryProposalsSection(ctx),
        'extractor proposals mutate post-turn; agent acts on or ignores'),
      // Session memory — agent-maintained notes that survive compaction.
      // Placed after memory proposals so the agent reads existing memories
      // first, then its own session-specific working notes. Mutates when
      // the agent calls update_session_memory mid-session.
      dynamicSection('session_memory', () => getSessionMemorySection(ctx),
        'session memory is updated by update_session_memory tool calls mid-session'),
      // ── Dynamic block (per-session / per-turn) ──────────────────
      // Each section below is wrapped with dynamicSection() and a written
      // reason — cache invalidation is a deliberate architectural choice,
      // not a default. Adding a new section here without a real reason is
      // a regression; if it can be static, move it above the boundary.
      dynamicSection('mcp', () => auxLoadedContent['agent_runtime.mcp_routing'] ?? sharedMcpIndexBlock(ctx.mcpTools),
        'MCP server list changes when developer connects/disconnects servers'),
      dynamicSection('team', () => teamSection,
        'in-flight background agent list changes per turn'),
      dynamicSection('background_commands', () => bgCommandsSection,
        'running/completed background shell commands'),
      dynamicSection('template_context', () => getTemplateContextSection(ctx),
        '.toquemedia/project.json or .toquemedia-template changes when scaffold is re-run'),
      dynamicSection('environment', () => getEnvironmentSection(ctx),
        'project path / package manager / language detected per session'),
      dynamicSection('preview_compatibility', () => getPreviewCompatibilitySection(ctx),
        'framework/deploy compatibility detected per project — null for compatible projects'),
      dynamicSection('dev_server_status', () => auxLoadedContent['delivery.dev_server'] ?? null,
        'dev server status flips null→starting→running→stopped per session'),
      dynamicSection('hashtag_skills', () => getHashtagSkillsSection(ctx),
        'hashtag-signalled skills vary with the current user message'),
      // Git orientation BEFORE the file tree: branch + changed files is the
      // first thing the model wants to know ("where am I, what's dirty"),
      // and pre-empts a reflexive `git status` / `git diff` tool call.
      dynamicSection('git_status', () => auxLoadedContent['delivery.git_status'] ?? null,
        'branch + working-tree changes shift every turn — null when not a git repo'),
      dynamicSection('project_structure', () => auxLoadedContent['project.structure_full'] ?? auxLoadedContent['project.structure_overview'] ?? getProjectStructureIndexSection(ctx),
        'file tree shifts on every write — fsVersion drives cache key'),
      dynamicSection('project_package_map', () => auxLoadedContent['project.package_map'] ?? null,
        'package summary loaded only for package/build/project planning tasks'),
      dynamicSection('project_entrypoints', () => auxLoadedContent['project.entrypoints'] ?? null,
        'entrypoint summary loaded only for architecture/routing tasks'),
      dynamicSection('agent_runtime_policy', () => [
        auxLoadedContent['agent_runtime.tool_profiles'] ?? '',
        auxLoadedContent['agent_runtime.request_context_policy'] ?? '',
        auxLoadedContent['agent_runtime.memory_context'] ?? '',
      ].filter(Boolean).join('\n\n') || null,
        'agent runtime context loaded only for tool/context/memory tasks'),
      dynamicSection('delivery_build_scripts', () => auxLoadedContent['delivery.build_scripts'] ?? null,
        'build scripts loaded only for build/test/runtime tasks'),
      dynamicSection('delivery_changed_files', () => auxLoadedContent['delivery.changed_files'] ?? null,
        'changed-file context loaded only for git/changed-file tasks'),
      dynamicSection('project_docs', () => auxLoadedContent['project.docs_full'] ?? null,
        'full project documents loaded only when explicitly requested'),
      // Recently-modified files AFTER the tree: the tree says what exists, this
      // says what was touched last — the likely working set.
      dynamicSection('recent_files', () => getRecentFilesSection(ctx),
        'mtime ordering changes on every save'),
      dynamicSection('readme', () => getReadmeSection(ctx),
        'README.md is developer-editable and used as primary intent signal'),
      dynamicSection('project_memory', () => getProjectMemorySection(ctx),
        'TMS.md/PLAN.md/TODO.md churn during normal IDE work'),
      dynamicSection('active_plan', () => getActivePlanSection(ctx),
        'PLAN.md status flips DRAFT → PENDING APPROVAL → APPROVED mid-session'),
      // Live tracker BEFORE the static TODO.md because the live state is
      // authoritative for "where am I / what's next" — the TODO.md
      // markdown carries the task DECOMPOSITION (which tasks exist, what
      // each requires) but its statuses are stale by design (it's the
      // architect's snapshot, not the implementer's progress). With the
      // live block first the model anchors on the actual state and reads
      // TODO.md as the supporting plan, not the other way around.
      dynamicSection('task_tracker_live', () => getTrackerStateSection(ctx),
        'live in-memory tracker mutated by every update_tasks call'),
      dynamicSection('task_list', () => getTaskListSection(ctx),
        'TODO.md task statuses flip as the implementation agent progresses'),
      dynamicSection('memory_guidance', () => getMemoryGuidanceSection(ctx),
        'guidance is conditional on the presence of project memory files'),
      dynamicSection('skills', () => getSkillsSection(loadedSkills),
        'skill set depends on project-type detection + hashtag triggers'),
      // Reminder stays at the very end — U-Curve recency outweighs cache
      // alignment here (the bookend rule depends on being last seen).
      dynamicSection('reminder', () => getReminderSection(ctx),
        'cites MCP + skill names captured from current session state'),
    ].filter((s): s is string => s !== null && s !== undefined && s !== '')

    // Per-section byte breakdown for optimization telemetry.
    // Extracts the first heading (# or ##) as the section name, falls back
    // to the first 40 chars of content. Top 15 by byte count.
    const sectionBreakdown = sections
      .filter(s => !s.includes('__TM_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'))
      .map(s => {
        const headingMatch = s.match(/^#{1,2}\s+(.+?)$/m)
        const name = headingMatch ? headingMatch[1].slice(0, 50) : s.slice(0, 40).replace(/\n/g, ' ')
        return { name, bytes: s.length, tokens_est: Math.ceil(s.length / 3.5) }
      })
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 15)

    const full = sections.join('\n\n')
    const telemetryAfterRender = getTmsTurnTelemetry()
    const symbolIndexTelemetry = telemetryAfterRender.symbolIndexRequested
      ? {
          filesConsidered: telemetryAfterRender.symbolIndexFilesConsidered,
          filesScanned: telemetryAfterRender.symbolIndexFilesScanned,
          entries: telemetryAfterRender.symbolIndexEntries,
          truncated: telemetryAfterRender.symbolIndexTruncated,
          tokensEstimate: telemetryAfterRender.symbolIndexTokensEstimate,
        }
      : undefined
    this.promptCache.set(cacheKey, { key: cacheKey, prompt: full, expiresAt: now + PROMPT_CACHE_TTL_MS, symbolIndexTelemetry, auxiliaryCtx: { pmDetected: ctx.pmDetected, isVanillaWeb: ctx.isVanillaWeb, promptCtx: ctx, loadedSkills } })
    // Cache-miss telemetry — includes the boundary split bytes so we can
    // see the prompt shape over time (regressions in cache discipline
    // surface as the static byte share shrinking).
    emitPromptBuiltTelemetry({
      mode: 'chat',
      cacheHit: false,
      prompt: full,
      plan: planKey,
      agentLang: agentLangKey,
      fsVersion,
      mcpToolCount: (mcpTools ?? []).length,
      loadedSkillNames: ctx.loadedSkillNames,
      sectionBreakdown,
    })
    return full
  }

  async buildCmdModeSystemPrompt(
    cwd: string,
    homeDir: string | null,
    mcpTools?: { name: string; description: string; serverName: string }[],
    userMessage?: string,
    intentOverride?: IntentOverride,
  ): Promise<string> {
    const normalizedCwd = cwd.replace(/\\/g, '/')
    const normalizedHome = homeDir ? homeDir.replace(/\\/g, '/') : null
    this.lastAuxiliarySelection = intentOverride
      ? selectAuxiliaries(
        intentOverride.profile,
        userMessage,
        intentOverride.readOnly,
        intentOverride.reason,
        intentOverride.source
          ? {
              source: intentOverride.source,
              confidence: intentOverride.confidence,
              error: intentOverride.error,
              diagnostics: intentOverride.diagnostics,
            }
          : undefined,
        undefined,
        undefined,
        intentOverride.requiresMutation === true,
      )
      : null

    // Parallel gather — language + memory files + session memory + memdir indexes
    const [langInstruction, globalTmsContent, tmsContent, sessionMemory, userMemIdx, projectMemIdx] = await Promise.all([
      getLangInstruction(),
      normalizedHome ? safeReadFile(`${normalizedHome}/.toquemedia-studio/TMS.md`) : Promise.resolve(null),
      safeReadFile(`${normalizedCwd}/TMS.md`),
      (async () => {
        try {
          const { useChatStore } = await import('../../stores/chatStore')
          return useChatStore.getState().getActiveSession()?.sessionMemory ?? null
        } catch { return null }
      })(),
      // Persistent memory indexes — same I/O as runMemoryWork, but without
      // the selector because indexes are cheap at this point.
      loadCmdMemoryIndex('user'),
      loadCmdMemoryIndex('project', normalizedCwd),
    ])

    const memoryHasStale = userMemIdx.hasStale || projectMemIdx.hasStale

    const ctx: CmdPromptContext = {
      cwd,
      normalizedCwd,
      homeDir,
      normalizedHome,
      globalTmsContent,
      tmsContent,
      sessionMemory,
      userMemoryIndex: userMemIdx.content,
      projectMemoryIndex: projectMemIdx.content,
      memoryHasStale,
      langInstruction,
      mcpTools: mcpTools || [],
    }

    // Load skills upfront so the reminder section at the bottom can re-cite
    // their names (U-Curve recency reinforcement — without this, the
    // hashtag-skills section that lives in the middle of the prompt is
    // forgotten in long sessions). loadSkills is cached so the subsequent
    // getCmdSkillsSection call hits the cache for free.
    const pkgSummaryForSkills = await extractPackageSummary(normalizedCwd)
    const detectedTypeForSkills = detectProjectType(pkgSummaryForSkills)
      ?? await detectProjectTypeFromFiles(normalizedCwd)
    let loadedSkillNames: string[] = []
    try {
      const skills = await SkillService.getInstance().loadSkills(normalizedCwd, detectedTypeForSkills, 'cmd')
      loadedSkillNames = skills.map(s => s.name)
    } catch { /* non-critical */ }

    // Resolve hashtag-skills section in parallel with skills section (both
    // touch the same SkillService cache; resolving sequentially would waste a
    // round-trip on the second call).
    const [hashtagSkillsSection, skillsSection] = await Promise.all([
      getCmdHashtagSkillsSection(normalizedCwd, userMessage),
      getCmdSkillsSection(ctx),
    ])

    const sections = [
      // ── Static block (cacheable cross-session) ──────────────────
      getCmdCompletionContractSection(),
      getCmdRoleSection(ctx),
      sharedIdentity(),
      getCmdSystemSection(),
      getCmdDoingTasksSection(),
      getCmdExecutingActionsSection(),
      sharedShellExecutionLoop('cmd'),
      getCmdClosedLoopSection(),
      getCmdToolsSection(),
      getCmdSessionGuidanceSection(),
      getCmdSecuritySection(),
      getCmdConstraintsSection(ctx),
      `${sharedUiBaselineCore()}\n\n${sharedTasteDefaults()}`,
      sharedToneAndStyle(),
      sharedOutputEfficiency(),
      sharedContextPreservation(),
      sharedTurnEfficiency(),
      // Memory taxonomy + save/forget discipline. The rules are stable
      // across sessions.
      getCmdMemoryToolsGuidanceSection(),
      // ── Boundary: everything below varies per session / per turn ──
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      // ── Dynamic block (per-session / per-turn) ──────────────────
      // Wrapped with dynamicSection() — see the project prompt block for the
      // contract: every section below must declare a non-empty reason or
      // the wrapper throws at build time.
      dynamicSection('mcp', () => sharedMcpBlock(ctx.mcpTools, 'user'),
        'MCP server list changes when user connects/disconnects servers'),
      dynamicSection('environment', () => getCmdEnvironmentSection(ctx),
        'cwd / homeDir / platform detected per session'),
      dynamicSection('dev_server_status', () => getDevServerStatusSection(),
        'dev server status flips null→starting→running→stopped per session'),
      // Hashtag-triggered sticky CRITICAL rules.
      // Placed BEFORE the generic skills index so the matched skill rules
      // are read by the model before it sees the generic "skills available"
      // listing. Re-cited by name in the
      // reminder section below to defeat the U-Curve middle-dip.
      dynamicSection('hashtag_skills', () => hashtagSkillsSection,
        'sticky hashtag rules depend on the current user message'),
      dynamicSection('skills', () => skillsSection,
        'skill set depends on project-type detection'),
      dynamicSection('global_memory', () => getCmdGlobalMemorySection(ctx),
        '~/.toquemedia-studio/TMS.md is user-editable'),
      // TMS.md content stub — injects headings/metadata, not the full project
      // memory body. Placed before guidance so the agent knows whether TMS.md
      // exists before it receives maintenance rules.
      dynamicSection('tms_content', () => getCmdTmsContentSection(ctx),
        'TMS.md content changes as the agent updates it'),
      // TMS.md guidance — asks for creation only when missing, otherwise
      // keeps maintenance compact and tied to durable project facts.
      dynamicSection('tms_guidance', () => getCmdTmsGuidanceSection(ctx),
        'TMS.md existence is a per-session check (file may be created mid-session)'),
      // Persistent memory — user-scope + project-scope MEMORY.md indexes.
      // Placed after TMS.md content so the model reads project memory first,
      // then cross-session memory facts.
      dynamicSection('memory', () => getCmdMemorySection(ctx),
        'MEMORY.md indexes mutate as save_memory / forget_memory run'),
      // Session memory — agent-maintained notes that survive compaction.
      dynamicSection('session_memory', () => getCmdSessionMemorySection(ctx),
        'session memory is updated by update_session_memory tool calls mid-session'),
      dynamicSection('language_reinforcement', () => getCmdLanguageReinforcementSection(ctx),
        'reinforcement is conditional on detected agent language'),
      // Reminder stays at the very end — U-Curve recency outweighs cache
      // alignment here (the bookend rule depends on being last seen).
      dynamicSection('reminder', () => getCmdReminderSection(loadedSkillNames),
        'cites loaded skill names captured from current session state'),
    ].filter((s): s is string => s !== null && s !== undefined && s !== '')

    const cmdSectionBreakdown = sections
      .map(s => {
        const headingMatch = s.match(/^#{1,2}\s+(.+?)$/m)
        const name = headingMatch ? headingMatch[1].slice(0, 50) : s.slice(0, 40).replace(/\n/g, ' ')
        return { name, bytes: s.length, tokens_est: Math.ceil(s.length / 3.5) }
      })
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 15)

    const fullCmd = sections.join('\n\n')
    // Cwd-scoped prompt builds may not have a billing-plan or fsVersion
    // concept, so emit "n/a" for dimensions that do not apply.
    emitPromptBuiltTelemetry({
      mode: 'cmd',
      sectionBreakdown: cmdSectionBreakdown,
      cacheHit: false,
      prompt: fullCmd,
      plan: 'n/a',
      agentLang: ctx.langInstruction ? 'detected' : 'en',
      fsVersion: 0,
      mcpToolCount: (mcpTools ?? []).length,
      loadedSkillNames,
    })
    return fullCmd
  }
}

/**
 * Fire-and-forget telemetry for assembled system prompts (technique #22).
 * Emits one event per `buildSystemPrompt` / `buildCmdModeSystemPrompt` call
 * — including cache hits — so we can compute hit-rate and watch the
 * static/dynamic byte split over time. Never throws, never blocks.
 *
 * Why aggregate (not per-section): firing 30 events per turn is expensive
 * in analytics ingest without a specific question to answer. The aggregate
 * `prompt_built` event answers the practical questions (regression cohort,
 * cache health, MCP/skill load shape) with one event.
 */
function emitPromptBuiltTelemetry(args: {
  mode: 'chat' | 'cmd'
  cacheHit: boolean
  prompt: string
  plan: string
  agentLang: string
  fsVersion: number
  mcpToolCount: number
  loadedSkillNames: string[]
  sectionBreakdown?: Array<{ name: string; bytes: number; tokens_est: number }>
}): void {
  const stats = splitOnBoundary(args.prompt)
  import('../../services/analytics').then(({ trackEvent }) =>
    trackEvent('prompt_built', {
      mode: args.mode,
      plan: args.plan,
      agent_lang: args.agentLang,
      cache_hit: args.cacheHit,
      total_bytes: args.prompt.length,
      static_bytes: stats.stats.staticBytes,
      dynamic_bytes: stats.stats.dynamicBytes,
      boundary_found: stats.stats.found,
      fs_version: args.fsVersion,
      mcp_tool_count: args.mcpToolCount,
      skill_count: args.loadedSkillNames.length,
      skill_names: args.loadedSkillNames.slice(0, 8).join(','),
      ...(args.sectionBreakdown && {
        section_breakdown: JSON.stringify(args.sectionBreakdown),
      }),
    }),
  ).catch(() => { /* analytics failures never block prompt build */ })
}

// Suppress "unused" tree-shaker warning — the symbol is exported via the
// helpers module but referenced here so future callers can import it
// transitively from `./contextBuilder` if they prefer the legacy path.
void _sanitizeProjectContent

export default ContextBuilder
