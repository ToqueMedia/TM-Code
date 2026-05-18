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
  extractCriticalSections,
  extractCriticalSectionsWithStats,
  sanitizeProjectContent as _sanitizeProjectContent,
  skillsFromHashtags,
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
  getModelSpecificSection,
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
    if (cached && cached.expiresAt > now) return cached.prompt
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
      getClosedLoopSection(),
      getToolsSection(ctx),
      getConstraintsSection(ctx),
      sharedUiBaseline(),
      sharedToneAndStyle(),
      sharedOutputEfficiency(),
      sharedContextPreservation(),
      // ── Boundary: everything below varies per session / per turn ──
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      // ── Dynamic block (per-session / per-turn) ──────────────────
      sharedMcpBlock(ctx.mcpTools, 'developer'),
      await getBackgroundAgentsSection(),
      getTemplateContextSection(ctx),
      getEnvironmentSection(ctx),
      getAppliedScaffoldingSection(ctx),
      getProjectStructureSection(ctx),
      getReadmeSection(ctx),
      getProjectMemorySection(ctx),
      getActivePlanSection(ctx),
      getTaskListSection(ctx),
      getMemoryGuidanceSection(ctx),
      getSkillsSection(loadedSkills),
      // Reminder stays at the very end — U-Curve recency outweighs cache
      // alignment here (the bookend rule depends on being last seen).
      getReminderSection(ctx),
    ].filter((s): s is string => s !== null && s !== undefined && s !== '')

    const full = sections.join('\n\n')
    this.promptCache.set(cacheKey, { key: cacheKey, prompt: full, expiresAt: now + PROMPT_CACHE_TTL_MS })
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
      sharedMcpBlock(ctx.mcpTools, 'user'),
      getCmdEnvironmentSection(ctx),
      // Scaffolding-aware framing + hashtag-triggered sticky CRITICAL rules.
      // Placed BEFORE the generic skills index so the matched skill rules
      // are read by the model before it sees the generic "skills available"
      // listing — same ordering chat mode uses. Re-cited by name in the
      // reminder section below to defeat the U-Curve middle-dip.
      scaffoldingSection,
      skillsSection,
      getCmdGlobalMemorySection(ctx),
      getCmdClaudeMdSection(ctx),
      getCmdLanguageReinforcementSection(ctx),
      // Reminder stays at the very end — U-Curve recency outweighs cache
      // alignment here (the bookend rule depends on being last seen).
      getCmdReminderSection(loadedSkillNames),
    ].filter((s): s is string => s !== null && s !== undefined && s !== '')

    return sections.join('\n\n')
  }
}

// Suppress "unused" tree-shaker warning — the symbol is exported via the
// helpers module but referenced here so future callers can import it
// transitively from `./contextBuilder` if they prefer the legacy path.
void _sanitizeProjectContent

export default ContextBuilder
