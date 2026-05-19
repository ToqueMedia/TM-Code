/**
 * ContextBuilder — chat-mode + cmd-mode system-prompt orchestrator.
 *
 * **Where the content lives** (May 2026 slice):
 *
 *   - Module-level helpers and constants  →  `contextBuilder/helpers.ts`
 *   - Shared types (PromptContext etc.)   →  `contextBuilder/types.ts`
 *   - File-tree / pkg / lang utilities    →  `contextBuilder/projectUtils.ts`
 *   - Cross-mode shared snippets          →  `contextBuilder/sections/sharedSections.ts`
 *   - The big Publishing section          →  `contextBuilder/sections/chatPublishing.ts`
 *   - Chat-mode section builders          →  `contextBuilder/sections/chatSections.ts`
 *   - CMD-mode section builders           →  `contextBuilder/sections/cmdSections.ts`
 *
 * This file keeps the class itself: cache state, the public
 * `buildSystemPrompt` / `buildCmdModeSystemPrompt` entry points, and
 * `invalidatePromptCache`. Section content is composed by importing the
 * pure builder functions and concatenating them in the documented U-Curve
 * order (primacy → middle → recency). Re-exports preserve the legacy
 * import surface so existing call sites (and tests) keep working.
 */

import SkillService from './skillService'
import {
  CRITICAL_SECTIONS_MAX_BYTES,
  PROMPT_CACHE_TTL_MS,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  dynamicSection,
  extractCriticalSections,
  extractCriticalSectionsWithStats,
  sanitizeProjectContent as _sanitizeProjectContent,
  skillsFromHashtags,
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
  getLangInstruction,
  readTemplateManifest,
  safeReadFile,
} from './contextBuilder/projectUtils'
import {
  sharedContextPreservation,
  sharedIdentity,
  sharedMcpBlock,
  sharedOutputEfficiency,
  sharedToneAndStyle,
  sharedUiBaseline,
} from './contextBuilder/sections/sharedSections'
import {
  getActivePlanSection,
  getAppliedScaffoldingSection,
  getBackgroundAgentsSection,
  getClosedLoopSection,
  getCompletionContractSection,
  getConstraintsSection,
  getDoingTasksSection,
  getEnvironmentSection,
  getExecutingActionsSection,
  getMemoryGuidanceSection,
  getMemorySection,
  getMemoryToolsGuidanceSection,
  getModelSpecificSection,
  getPendingMemoryProposalsSection,
  getProjectMemorySection,
  getProjectStructureSection,
  getReadmeSection,
  getReminderSection,
  getRoleSection,
  getSkillsSection,
  getSystemSection,
  getTaskListSection,
  getTemplateContextSection,
  getToolsSection,
  getTrackerStateSection,
} from './contextBuilder/sections/chatSections'
import {
  getCmdAppliedScaffoldingSection,
  getCmdClaudeMdSection,
  getCmdClosedLoopSection,
  getCmdCompletionContractSection,
  getCmdConstraintsSection,
  getCmdDoingTasksSection,
  getCmdEnvironmentSection,
  getCmdExecutingActionsSection,
  getCmdGlobalMemorySection,
  getCmdLanguageReinforcementSection,
  getCmdReminderSection,
  getCmdRoleSection,
  getCmdSecuritySection,
  getCmdSessionGuidanceSection,
  getCmdSkillsSection,
  getCmdSystemSection,
  getCmdToolsSection,
} from './contextBuilder/sections/cmdSections'

// ── Re-exports — keep the legacy import surface so external callers (tests,
// other services) don't have to update their import paths after the slice. ──

export {
  CRITICAL_SECTIONS_MAX_BYTES,
  extractCriticalSections,
  extractCriticalSectionsWithStats,
  skillsFromHashtags,
}
export type { PromptContext, CmdPromptContext, MCPToolSummary, PackageSummary }

class ContextBuilder {
  private static instance: ContextBuilder
  private promptCache = new Map<string, PromptCacheEntry>()

  static getInstance(): ContextBuilder {
    if (!ContextBuilder.instance) {
      ContextBuilder.instance = new ContextBuilder()
    }
    return ContextBuilder.instance
  }

  /**
   * Invalidate cached prompts for a project (or all projects if omitted).
   * Call after write operations that touch README.md, TMS.md, PLAN.md, TODO.md,
   * package.json, .toquemedia-template, or .toquemedia-id. The last one matters:
   * if the agent writes .toquemedia-id mid-session (standardization pass), the
   * next prompt must reflect tm_code_owned=true, not the cached false.
   */
  invalidatePromptCache(projectPath?: string): void {
    if (!projectPath) {
      this.promptCache.clear()
      return
    }
    for (const key of this.promptCache.keys()) {
      if (key.startsWith(`${projectPath}|`)) this.promptCache.delete(key)
    }
  }

  async buildSystemPrompt(projectPath: string, projectType: string, mcpTools?: MCPToolSummary[], coreToolCount?: number, userMessage?: string): Promise<string> {
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
    // tags changes — same conversation but the user just typed `#auth-google`
    // for the first time should re-render with the auth skill inlined.
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
    const cacheKey = `${projectPath}|${projectType}|${coreToolCount ?? 20}|${planKey}|${agentLangKey}|${mcpSig}|${stickyHashtagSig}|fs${fsVersion}`

    const now = Date.now()
    const cached = this.promptCache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      // Cache-hit telemetry — cheap, lets us measure hit rate. The bytes
      // metric is still useful even when cached because the value matches
      // the original miss's bytes; the proxy uses these to monitor the
      // static/dynamic split health over time.
      emitPromptBuiltTelemetry({
        mode: 'chat',
        cacheHit: true,
        prompt: cached.prompt,
        plan: planKey,
        agentLang: agentLangKey,
        fsVersion,
        mcpToolCount: (mcpTools ?? []).length,
        loadedSkillNames: [],
      })
      return cached.prompt
    }
    // Gather context in parallel for speed
    const { detectScaffolding } = await import('../scaffoldingDetector')
    const [treeString, pkgSummary, readme, templateManifest, tmsContent, planContent, todoContent, toquemediaIdRaw, appliedScaffolding] = await Promise.all([
      buildFileTree(projectPath),
      extractPackageSummary(projectPath),
      safeReadFile(`${projectPath}/README.md`),
      readTemplateManifest(projectPath),
      safeReadFile(`${projectPath}/TMS.md`),
      safeReadFile(`${projectPath}/PLAN.md`),
      safeReadFile(`${projectPath}/TODO.md`),
      safeReadFile(`${projectPath}/.toquemedia-id`),
      detectScaffolding(projectPath),
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

    // Load model profile for model-specific behavior (based on plan, not user choice)
    let modelProfile: import('./modelProfiles').ModelProfile | null = null
    try {
      const { getProfileForPlan } = await import('./modelProfiles')
      const { useBillingStore } = await import('../../stores/billingStore')
      const plan = useBillingStore.getState().plan
      modelProfile = getProfileForPlan(plan)
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
      }))
    } catch { /* non-critical */ }

    // Persistent memory — user-scope and project-scope MEMORY.md indexes.
    // Loaded in parallel to keep the prompt build cheap; failures fall
    // through to `null` which simply drops the section.
    //
    // Selector pass: when the combined index byte count exceeds the
    // `MEMORY_SELECTOR_THRESHOLD_BYTES` threshold, ask the per-plan
    // selector model which entries are relevant to the current user
    // request and inject only those. Below threshold we keep the full
    // indexes — the selector's ~300-600ms latency isn't worth saving
    // a few hundred tokens. Failure path returns null which falls back
    // to injecting everything (the pre-selector default behaviour).
    let userMemoryIndex: string | null = null
    let projectMemoryIndex: string | null = null
    try {
      const { loadMemoryIndex, parseIndexEntries, projectIndexEntries } = await import('./memdir')
      const [userResult, projectResult] = await Promise.all([
        loadMemoryIndex('user'),
        loadMemoryIndex('project', projectPath),
      ])
      userMemoryIndex = userResult.content
      projectMemoryIndex = projectResult.content

      const combinedBytes = (userResult.byteCount || 0) + (projectResult.byteCount || 0)
      const { MEMORY_SELECTOR_THRESHOLD_BYTES } = await import('./memorySelector')
      if (
        userMessage
        && combinedBytes > MEMORY_SELECTOR_THRESHOLD_BYTES
      ) {
        const userEntries = userMemoryIndex ? parseIndexEntries(userMemoryIndex) : []
        const projectEntries = projectMemoryIndex ? parseIndexEntries(projectMemoryIndex) : []
        const allEntries = [...userEntries, ...projectEntries]
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
              userMemoryIndex = projected.includes('](') ? projected : null
            }
            if (projectMemoryIndex) {
              const projected = projectIndexEntries(projectMemoryIndex, selection.selectedNames)
              projectMemoryIndex = projected.includes('](') ? projected : null
            }

            // Fire-and-forget telemetry — lets us measure selector value
            // (token reduction) vs cost (latency / hit rate) in aggregate.
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
          // selection === null → selector failed; userMemoryIndex /
          // projectMemoryIndex stay as the full content (inject-all
          // fallback).
        }
      }
    } catch { /* memdir is best-effort, prompt builds fine without it */ }

    // Pending memory proposals — surfaced as a system reminder when the
    // post-turn extractor identified facts worth saving in a prior turn
    // and the agent hasn't yet acted on them. Lives in the dynamic block
    // (changes between turns as proposals are added / saved / expire).
    let pendingMemoryProposals: string | null = null
    try {
      const { buildProposalsReminder } = await import('./memoryProposalsStore')
      pendingMemoryProposals = await buildProposalsReminder(projectPath)
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
      readme,
      tmsContent,
      planContent,
      todoContent,
      templateManifest,
      langInstruction,
      modelProfile,
      mcpTools: mcpTools || [],
      coreToolCount: coreToolCount ?? 20,
      loadedSkillNames: loadedSkills.map(s => s.name),
      appliedScaffolding,
      hashtagSkills: stickyHashtagSkills,
      currentTasks,
      userMemoryIndex,
      projectMemoryIndex,
      pendingMemoryProposals,
    }

    // Resolve the async background-agents section once so dynamicSection()
    // can stay synchronous below — the wrapper exists to enforce a
    // declarative `(name, body, reason)` shape, not to host the async I/O.
    const bgAgentsSection = await getBackgroundAgentsSection()

    const sections = [
      // ── Static block (cacheable cross-session) ──────────────────
      getCompletionContractSection(),
      getRoleSection(ctx),
      sharedIdentity(),
      getModelSpecificSection(ctx),
      getSystemSection(),
      getDoingTasksSection(ctx),
      getExecutingActionsSection(),
      getClosedLoopSection(),
      getToolsSection(ctx),
      getConstraintsSection(ctx),
      sharedUiBaseline(),
      sharedToneAndStyle(),
      sharedOutputEfficiency(),
      sharedContextPreservation(),
      // Memory taxonomy + save/forget discipline. The rules of the
      // memory system are stable across sessions (the data on disk
      // mutates, but the schema/contract is fixed), so this guidance
      // lives in the static block. The actual memory CONTENT is injected
      // below the boundary via getMemorySection.
      getMemoryToolsGuidanceSection(),
      // ── Boundary: everything below varies per session / per turn ──
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      // Persistent memory — placed first in the dynamic block because it's
      // the most authoritative per-session context (cross-session facts the
      // developer established). Below the cache boundary because the indexes
      // mutate when the model saves/forgets memories mid-session, so static-
      // caching them would serve stale content.
      dynamicSection('memory', () => getMemorySection(ctx),
        'MEMORY.md indexes mutate as save_memory / forget_memory run'),
      // Pending auto-extracted proposals — surfaced AFTER the existing
      // memory section so the agent reads what's already saved first,
      // then decides which proposals add real new information vs duplicate
      // what's there. Mutates on every post-turn extractor run.
      dynamicSection('memory_proposals', () => getPendingMemoryProposalsSection(ctx),
        'extractor proposals mutate post-turn; agent acts on or ignores'),
      // ── Dynamic block (per-session / per-turn) ──────────────────
      // Each section below is wrapped with dynamicSection() and a written
      // reason — cache invalidation is a deliberate architectural choice,
      // not a default. Adding a new section here without a real reason is
      // a regression; if it can be static, move it above the boundary.
      dynamicSection('mcp', () => sharedMcpBlock(ctx.mcpTools, 'developer'),
        'MCP server list changes when developer connects/disconnects servers'),
      dynamicSection('background_agents', () => bgAgentsSection,
        'in-flight background agent list changes per turn'),
      dynamicSection('template_context', () => getTemplateContextSection(ctx),
        '.toquemedia-template manifest changes when scaffold is re-run'),
      dynamicSection('environment', () => getEnvironmentSection(ctx),
        'project path / package manager / language detected per session'),
      dynamicSection('applied_scaffolding', () => getAppliedScaffoldingSection(ctx),
        'one-shot flow markers (auth, payments) appear after scaffold writes'),
      dynamicSection('project_structure', () => getProjectStructureSection(ctx),
        'file tree shifts on every write — fsVersion drives cache key'),
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

    const full = sections.join('\n\n')
    this.promptCache.set(cacheKey, { key: cacheKey, prompt: full, expiresAt: now + PROMPT_CACHE_TTL_MS })
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
    })
    return full
  }

  async buildCmdModeSystemPrompt(
    cwd: string,
    homeDir: string | null,
    mcpTools?: { name: string; description: string; serverName: string }[],
    userMessage?: string,
  ): Promise<string> {
    const normalizedCwd = cwd.replace(/\\/g, '/')
    const normalizedHome = homeDir ? homeDir.replace(/\\/g, '/') : null

    // Parallel gather — language + memory files together
    const [langInstruction, globalTmsContent, claudeMdContent] = await Promise.all([
      getLangInstruction(),
      normalizedHome ? safeReadFile(`${normalizedHome}/.toquemedia-studio/TMS.md`) : Promise.resolve(null),
      safeReadFile(`${normalizedCwd}/CLAUDE.md`),
    ])

    const ctx: CmdPromptContext = {
      cwd,
      normalizedCwd,
      homeDir,
      normalizedHome,
      globalTmsContent,
      claudeMdContent,
      langInstruction,
      mcpTools: mcpTools || [],
    }

    // Load skills upfront so the reminder section at the bottom can re-cite
    // their names (U-Curve recency reinforcement — without this, the
    // scaffolding-aware section that lives in the middle of the prompt is
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

    // Resolve scaffolding-aware section in parallel with skills section (both
    // touch the same SkillService cache; resolving sequentially would waste a
    // round-trip on the second call).
    const [scaffoldingSection, skillsSection] = await Promise.all([
      getCmdAppliedScaffoldingSection(normalizedCwd, userMessage),
      getCmdSkillsSection(ctx),
    ])

    const sections = [
      // ── Static block (cacheable cross-session) ──────────────────
      getCmdCompletionContractSection(),
      getCmdRoleSection(ctx),
      sharedIdentity(),
      getCmdSystemSection(),
      getCmdClosedLoopSection(),
      getCmdDoingTasksSection(),
      getCmdExecutingActionsSection(),
      getCmdToolsSection(),
      getCmdSessionGuidanceSection(),
      getCmdSecuritySection(),
      getCmdConstraintsSection(ctx),
      sharedUiBaseline(),
      sharedToneAndStyle(),
      sharedOutputEfficiency(),
      sharedContextPreservation(),
      // ── Boundary: everything below varies per session / per turn ──
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      // ── Dynamic block (per-session / per-turn) ──────────────────
      // Wrapped with dynamicSection() — see the chat-mode block for the
      // contract: every section below must declare a non-empty reason or
      // the wrapper throws at build time.
      dynamicSection('mcp', () => sharedMcpBlock(ctx.mcpTools, 'user'),
        'MCP server list changes when user connects/disconnects servers'),
      dynamicSection('environment', () => getCmdEnvironmentSection(ctx),
        'cwd / homeDir / platform detected per session'),
      // Scaffolding-aware framing + hashtag-triggered sticky CRITICAL rules.
      // Placed BEFORE the generic skills index so the matched skill rules
      // are read by the model before it sees the generic "skills available"
      // listing — same ordering chat mode uses. Re-cited by name in the
      // reminder section below to defeat the U-Curve middle-dip.
      dynamicSection('scaffolding', () => scaffoldingSection,
        'scaffolding markers + sticky hashtag rules depend on user message'),
      dynamicSection('skills', () => skillsSection,
        'skill set depends on project-type detection'),
      dynamicSection('global_memory', () => getCmdGlobalMemorySection(ctx),
        '~/.toquemedia-studio/TMS.md is user-editable'),
      dynamicSection('claude_md', () => getCmdClaudeMdSection(ctx),
        'CLAUDE.md is per-project and edited by the user'),
      dynamicSection('language_reinforcement', () => getCmdLanguageReinforcementSection(ctx),
        'reinforcement is conditional on detected agent language'),
      // Reminder stays at the very end — U-Curve recency outweighs cache
      // alignment here (the bookend rule depends on being last seen).
      dynamicSection('reminder', () => getCmdReminderSection(loadedSkillNames),
        'cites loaded skill names captured from current session state'),
    ].filter((s): s is string => s !== null && s !== undefined && s !== '')

    const fullCmd = sections.join('\n\n')
    // CMD mode doesn't have a billing-plan or fsVersion concept (no project
    // is open at the harness level), so we emit "n/a" for the dimensions
    // that don't apply rather than forcing dummy values into the schema.
    emitPromptBuiltTelemetry({
      mode: 'cmd',
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
    }),
  ).catch(() => { /* analytics failures never block prompt build */ })
}

// Suppress "unused" tree-shaker warning — the symbol is exported via the
// helpers module but referenced here so future callers can import it
// transitively from `./contextBuilder` if they prefer the legacy path.
void _sanitizeProjectContent

export default ContextBuilder
