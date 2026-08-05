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
 *
 * This file keeps the class itself: cache state, the public
 * `buildSystemPrompt` entry point, and `invalidatePromptCache`. Section
 * content is composed by importing the pure builder functions and
 * concatenating them in the documented U-Curve order (primacy → middle →
 * recency). Re-exports preserve the legacy import surface so existing call
 * sites (and tests) keep working. (The cwd-scoped `buildCmdModeSystemPrompt`
 * + `sections/cmdSections.ts` were removed with the Terminal chat surface.)
 */

import SkillService from './skillService'
import {
  discoverExternalAgentSessions,
  buildExternalAgentSessionsSection,
  type ExternalAgentSessions,
} from './externalAgents'
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
  MCPToolSummary,
  PackageSummary,
  PathAlias,
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
  readGeneratedPaths,
  readProjectManifest,
  readTemplateManifest,
  safeReadFile,
} from './contextBuilder/projectUtils'
import {
  sharedContextPreservation,
  sharedIdentity,
  sharedMcpBlock,
  sharedMcpIndexBlock,
  sharedOutputEfficiency,
  sharedShellExecutionLoop,
  sharedToneAndStyle,
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
  getBackgroundInstallSection,
  getDoingTasksSection,
  getIdeUiGuideSection,
  getScaffoldingInstallSection,
  getVisionSection,
  getDevServerAuthoringRulesSection,
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
  type ContextPlanClassification,
  fallbackContextPlanForProfile,
  selectAuxiliaries,
  applyEvidenceOmissions,
  applyRenderedTokenCounts,
  resolveAuxiliaryId,
  type AuxiliarySelection,
  type PromptProfile,
  type RouterDiagnostics,
} from './contextBuilder/auxiliaryRegistry'
import {
  detectProjectContextEvidence,
  evidenceOmittedAuxiliaries,
} from './contextBuilder/projectEvidence'
import { loadProjectInstructions } from './projectInstructions'

type IntentOverride = {
  profile: PromptProfile
  readOnly: boolean
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
export type { PromptContext, MCPToolSummary, PackageSummary }

/**
 * Sumário de package.json em texto — não o objecto.
 *
 * `${pkgSummary}` numa template string rende "[object Object]", e era assim
 * que três auxiliares o entregavam ao modelo (auditoria 2026-07-29). Rende só
 * o que serve para descobrir comandos e stack: nome, scripts, deps (com o
 * total real quando a lista vem truncada).
 */
function renderPkgSummaryLines(pkg: PackageSummary | null | undefined): string {
  if (!pkg) return 'package summary: unavailable'
  const tail = (shown: number, total: number): string =>
    total > shown ? ` (+${total - shown} more)` : ''
  const parts = [`package summary: ${pkg.name}`]
  if (pkg.packageManager) parts.push(`  package manager field: ${pkg.packageManager}`)
  if (pkg.scripts.length) parts.push(`  scripts: ${pkg.scripts.join(', ')}`)
  if (pkg.dependencies.length) {
    parts.push(`  deps: ${pkg.dependencies.join(', ')}${tail(pkg.dependencies.length, pkg.dependencyCount)}`)
  }
  if (pkg.devDependencies.length) {
    parts.push(`  devDeps: ${pkg.devDependencies.join(', ')}${tail(pkg.devDependencies.length, pkg.devDependencyCount)}`)
  }
  return parts.join('\n')
}

/** Aliases de import em `alias→target`, em vez de "- [object Object]". */
function renderPathAliasLines(aliases: PathAlias[] | undefined): string | null {
  if (!aliases || aliases.length === 0) return null
  return `path aliases:\n${aliases.map(a => `- ${a.alias} → ${a.target}`).join('\n')}`
}

class ContextBuilder {
  private static instance: ContextBuilder
  private promptCache = new Map<string, PromptCacheEntry>()
  // Superfície de TAREFA PARALELA (fusão 4b): omite as secções do tracker
  // GLOBAL do agente interativo (task_tracker_live/task_list) — uma tarefa
  // não adota o backlog do main nem tem update_tasks no toolset dela.
  private taskSurface = false

  // ── Auxiliary context selection (on-demand architecture) ──
  // Set during buildSystemPrompt. Read by:
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

  // FASE B (recalibração de cache 2026-07-17): o bloco VOLÁTIL — tudo
  // abaixo do SYSTEM_PROMPT_DYNAMIC_BOUNDARY — sai do system prompt (que
  // fica byte-estável entre runs → prefixo tools+system+histórico cacheável
  // no provider) e segue na PRIMEIRA mensagem do user em <system-reminder>
  // (padrão claude-vaz). Preenchido em cada build, miss E hit.
  private lastVolatileContext: string | null = null

  /** Bloco volátil do último build — o caller anexa à mensagem do user. */
  getLastVolatileContext(): string | null {
    return this.lastVolatileContext
  }

  /** The auxiliary selection from the most recent prompt build (or null). */
  getLastAuxiliarySelection(): AuxiliarySelection | null {
    return this.lastAuxiliarySelection
  }

  private async renderAuxiliaryContent(id: string): Promise<string | null> {
    const ctx = this.lastAuxiliaryCtx
    const resolvedId = resolveAuxiliaryId(id)
    switch (resolvedId) {
      case 'scaffold.workflow':
        return ctx ? getScaffoldingInstallSection({ pmDetected: ctx.pmDetected }) : null
      case 'vision.image_rules':
        // Capacidade RESOLVIDA (declarada pelo worker × perfil local), a mesma
        // que decide se o sidecar de visão sequer corre — ver getVisionSection.
        return getVisionSection(ctx?.promptCtx?.modelProfile?.supportsAttachments === true)
      case 'design_system.semantic_tokens':
        return [
          '# Design system: semantic tokens',
          'Use for token/theme work only. Start by locating existing semantic token/theme files before editing.',
          'Expected files: src/theme/**/semantic*, src/theme/**/tokens*, src/themes/**, src/theme/index.ts.',
          'Prefer adding the smallest semantic alias that matches existing naming. Locate the expected files with the search/list/read tools before editing.',
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
      // Estas secções interpolavam OBJECTOS em template strings (auditoria
      // 2026-07-29): `${pkgSummary}` rendia "[object Object]" e
      // `pathAliases.map(a => \`- ${a}\`)` rendia uma lista de
      // "[object Object]". Três auxiliares — project.package_map,
      // project.entrypoints e delivery.build_scripts — entregavam isso ao
      // modelo como se fosse contexto. Pior do que não ter a secção: ocupa
      // tokens, parece dados e não diz nada.
      case 'project.package_map':
        if (!ctx?.promptCtx) return null
        // Sem package.json não há mapa nenhum: emitir o cabeçalho mais
        // "package summary: unavailable" custa tokens, parece dados e não diz
        // nada (mesmo padrão do "[object Object]" acima). O tipo de projecto e
        // o gestor de pacotes já vão na secção de ambiente.
        if (!ctx.promptCtx.pkgSummary) return null
        return [
          '# Project package map',
          `project type: ${ctx.promptCtx.projectType}`,
          `package manager: ${ctx.promptCtx.pmDetected}`,
          renderPkgSummaryLines(ctx.promptCtx.pkgSummary),
          renderPathAliasLines(ctx.promptCtx.pathAliases),
        ].filter(Boolean).join('\n')
      case 'project.entrypoints':
        if (!ctx?.promptCtx) return null
        return [
          '# Project entrypoints',
          'Expected entrypoint candidates: src/main.tsx, src/App.tsx, src/index.ts, src/routes/**, vite.config.*, tauri command modules.',
          renderPathAliasLines(ctx.promptCtx.pathAliases),
          'Use search/list/read tools to confirm the exact entrypoint before editing.',
        ].filter(Boolean).join('\n')
      case 'agent_runtime.mcp_routing':
        return ctx?.promptCtx ? sharedMcpBlock(ctx.promptCtx.mcpTools, 'developer') : null
      case 'agent_runtime.tool_profiles':
        return [
          '# Agent runtime: tool loading',
          'Local tool definitions are FROZEN for the whole run (stable schemas keep the provider prompt-cache prefix intact).',
          'MCP tool definitions are DEFERRED: the MCP section of the system prompt lists their names, and full schemas are only sent after you fetch them with `ToolSearch` (query "select:name" or keywords). One fetch is a single cache break at the moment of need — cheaper than shipping every MCP schema on every request.',
          'Expected files: src/services/agent/toolPolicy.ts (meta-tool definitions), src/services/agent/toolExecutor.ts (registry + deferral).',
        ].join('\n')
      case 'delivery.dev_server':
        // Só o ESTADO. As regras de autoria mudaram-se para o bloco estático
        // (getDevServerAuthoringRulesSection) — ver a nota lá sobre o custo de
        // casar bytes estáveis com bytes voláteis na mesma secção.
        return getDevServerStatusSection()
      case 'delivery.build_scripts':
        if (!ctx?.promptCtx) return null
        // Idem: sem package.json não há scripts para descobrir.
        if (!ctx.promptCtx.pkgSummary) return null
        return [
          '# Delivery: build scripts',
          `package manager: ${ctx.promptCtx.pmDetected}`,
          renderPkgSummaryLines(ctx.promptCtx.pkgSummary),
          'Use for build/test/dev command discovery before broader project structure.',
        ].join('\n')
      case 'delivery.git_status':
        return ctx?.promptCtx ? getGitStatusSection(ctx.promptCtx) : null
      default:
        return null
    }
  }

  /**
   * Instância EFÉMERA para runs de TAREFA PARALELA (fusão 4b, doutrina "sem
   * deus"): estado próprio (promptCache, lastAuxiliarySelection,
   * lastAuxiliaryCtx) — o singleton fica exclusivo do run interativo, que lê
   * getLastAuxiliarySelection() logo após o build DELE; partilhar a instância
   * entre agentes concorrentes corrompia essa leitura (single-active-run
   * assumption acima). request_context de uma tarefa resolve na instância
   * dela (o runner guarda a referência).
   */
  static createEphemeral(opts?: { taskSurface?: boolean }): ContextBuilder {
    const builder = new ContextBuilder()
    builder.taskSurface = opts?.taskSurface === true
    return builder
  }

  static getInstance(): ContextBuilder {
    if (!ContextBuilder.instance) {
      ContextBuilder.instance = new ContextBuilder()
    }
    return ContextBuilder.instance
  }

  /**
   * Invalidate cached prompts for a project (or all projects if omitted).
   * Call after write operations that touch README.md, TMS.md, AGENTS.md,
   * CLAUDE.md, .claude/CLAUDE.md, PLAN.md, TODO.md, package.json,
   * .toquemedia/project.json, .toquemedia-template, or .toquemedia-id.
   * The last one matters: if the agent writes .toquemedia-id mid-session
   * (standardization pass), the next prompt must reflect tm_code_owned=true,
   * not the cached false.
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

  async buildSystemPrompt(projectPath: string, projectType: string, mcpTools?: MCPToolSummary[], coreToolCount?: number, userMessage?: string, accessedPaths?: string[], intentOverride?: IntentOverride, signals?: { hasImage?: boolean }): Promise<string> {
    this.lastVolatileContext = null
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
    // NÃO há classificador nenhum antes do modelo principal: o Intent Router
    // foi REMOVIDO (uma classificação "read-only" errada chegou a negar
    // create/edit num run inteiro) e o Context Planner por modelo está
    // desligado. O perfil vem de uma heurística LOCAL sem poder de negação
    // (hasImage → vision, senão default_task) e a seleção da tabela
    // determinista abaixo. Comentários que descreviam estes dois como vivos
    // foram corrigidos na auditoria de 2026-07-28 — eram um convite a
    // ressuscitá-los.
    // Inline desde 2026-07-30. Havia aqui um `profileForSignals(userMessage,
    // { mentionedFiles, hasImage })` — uma função de "classificação" que
    // ignorava a mensagem E os ficheiros mencionados e devolvia um enum a
    // partir de um único booleano, para a tabela abaixo o converter de volta
    // numa lista de secções. Dois passos de indirecção sobre `hasImage`, com
    // um nome que prometia inferência e convidava a ressuscitar o router.
    const auxProfile: PromptProfile = intentOverride?.profile
      ?? (signals?.hasImage ? 'vision' : 'default_task')
    const readOnly = intentOverride?.readOnly ?? false
    // SELEÇÃO DE CONTEXTO: DETERMINISTA, sem chamar modelo nenhum.
    //
    // Houve aqui um planner por MODELO (chamada sidecar pré-voo). Foi desligado
    // na FASE C — poupava uma chamada por run e eliminava um vetor de viés real
    // (auditoria pg/bundler: o planner empurrava hipóteses de causa) — e APAGADO
    // na auditoria de 2026-07-28: ficava atrás de uma flag local com um convite
    // a religar, e o caminho que ela reabria valia até ~4 minutos de latência
    // pré-voo no pior caso (3 tentativas utility + 1 code, 60s cada, em série)
    // ANTES do primeiro token do modelo principal.
    //
    // A seleção vem da tabela por perfil + a baseline de delivery sempre ativa.
    // Esta última é o que impede o bug irmão: com selectedContexts vazio,
    // auxLoadedContent ficava {} e TODAS as secções que só leem dele rendiam
    // null — git status, estado do dev-server (com a regra "não arranques um
    // segundo servidor"), visão, scaffold — enquanto o gatherGitContext()
    // continuava a correr e a ser deitado fora. project_bootstrap fica
    // deliberadamente lean (inspeção focada + escrita de TMS.md).
    const basePlan = fallbackContextPlanForProfile(auxProfile)
    const deliveryBaseline = auxProfile === 'project_bootstrap'
      ? []
      : ['delivery.git_status', 'delivery.dev_server']
    const contextPlan: ContextPlanClassification = {
      plan: {
        ...basePlan,
        taskDomain: `${auxProfile}.deterministic`,
        candidateContexts: Array.from(new Set([...basePlan.candidateContexts, ...deliveryBaseline])),
        selectedContexts: Array.from(new Set([...basePlan.selectedContexts, ...deliveryBaseline])),
        rejectedContexts: [],
        reason: 'Full delivery: bounded sections inline + always-on delivery baseline; only unbounded contexts on-demand via request_context.',
      },
      source: 'deterministic',
      confidence: 'none',
      reason: 'deterministic full-delivery selection (no model call, no bias); unbounded contexts on-demand by the primary agent',
    }
    const plannerReason = `deterministic context selection: ${contextPlan.reason}`
    const auxSelection = selectAuxiliaries(
      auxProfile,
      userMessage,
      readOnly,
      intentOverride?.reason ? `${intentOverride.reason}; ${plannerReason}` : plannerReason,
      intentOverride?.source ? { source: intentOverride.source, confidence: intentOverride.confidence, error: intentOverride.error, diagnostics: intentOverride.diagnostics } : undefined,
      contextPlan.plan,
      {
        // 'deterministic', não 'fallback' (correcção 2026-08-03): fallback
        // implica que um planner falhou. Não há planner — a selecção
        // determinística É o desenho. Telemetria que auto-descreve o desenho
        // como degradação envenena a auto-análise (sessão momenu 02-08 lida
        // como "planner partido?" quando estava tudo como desenhado).
        status: 'deterministic',
        source: contextPlan.source,
        selectionReason: contextPlan.reason,
      },
    )
    this.lastAuxiliarySelection = auxSelection
    const contextPlanSig = [
      auxSelection.contextPlan.taskDomain,
      auxSelection.contextPlan.selectedContexts.join(','),
      auxSelection.contextPlan.candidateContexts.join(','),
    ].join('|')
    const cacheKeyBase = `${projectPath}|${projectType}|${coreToolCount ?? 20}|${planKey}|${agentLangKey}|${mcpSig}|${stickyHashtagSig}|fs${fsVersion}|ac${accessedCount}|p${auxProfile}|ro${auxSelection.readOnly ? 1 : 0}|cp${contextPlanSig}`

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

    // Gather context in parallel for speed. Project instructions (TMS + foreign
    // AGENTS/CLAUDE) go through loadProjectInstructions so compat repos without
    // TMS.md still surface developer rules at runtime.
    const [treeString, pkgSummary, readme, projectManifest, templateManifest, instructions, planContent, todoContent, toquemediaIdRaw, gitContext, recentFiles, pathAliases, generatedPaths] = await Promise.all([
      buildFileTree(projectPath),
      extractPackageSummary(projectPath),
      safeReadFile(`${projectPath}/README.md`),
      readProjectManifest(projectPath),
      readTemplateManifest(projectPath),
      loadProjectInstructions(projectPath),
      safeReadFile(`${projectPath}/PLAN.md`),
      safeReadFile(`${projectPath}/TODO.md`),
      safeReadFile(`${projectPath}/.toquemedia-id`),
      gatherGitContext(projectPath),
      gatherRecentFiles(projectPath),
      readPathAliases(projectPath),
      readGeneratedPaths(projectPath),
    ])
    const tmsContent = instructions.tms?.content ?? null
    const foreignInstructions = instructions.foreignPrimary
    // Any non-null content means the marker exists. We don't care about the ID
    // itself for prompt decisions — only whether TM Code authored the project.
    const tmCodeOwned = toquemediaIdRaw !== null

    const pmDetected = pkgSummary?.packageManager || await detectPackageManager(projectPath)
    const isTemplateProject = templateManifest !== null
    // ── FONTE ÚNICA de "que tipo de projecto é este" ──
    // Havia aqui uma segunda detecção, à mão, com a sua própria lista de
    // frameworks — a viver ao lado do portão de evidência e a poder discordar
    // dele. Duas respostas para a mesma pergunta é como um perfil morto
    // continua a parecer vivo: nenhuma das duas é obviamente a errada quando
    // divergem. `workspaceDependencies` entra na união (num monorepo a raiz não
    // declara framework nenhum) e a união é NÃO truncada (as listas do prompt
    // vêm cortadas a 15/10; detectar a partir delas dava falso negativo calado).
    const projectEvidence = detectProjectContextEvidence({ pkgSummary, treeString })
    const isVanillaWeb = !isTemplateProject && !projectEvidence.hasFrameworkDeps

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
      const local = modelName && MODEL_PROFILES[modelName] ? MODEL_PROFILES[modelName] : getProfileForPlan(plan)
      // A capacidade DECLARADA pelo data-plane sobrepõe-se ao perfil local
      // (auditoria 2026-07-29). Sem isto, o prompt anunciava "pesquisa web
      // nativa" a um modelo publicado só na KV que a herdava do perfil de
      // fallback — e o modelo confiava, deixando de chamar a tool que era o
      // seu único acesso real à web.
      const { effectiveCapability } = await import('./modelProfiles')
      const declaredSearch = useAgentStore.getState().modelSupportsSearch
      const declaredVision = useAgentStore.getState().modelSupportsVision
      modelProfile = {
        ...local,
        supportsSearch: effectiveCapability(declaredSearch, local.supportsSearch),
        supportsAttachments: effectiveCapability(declaredVision, local.supportsAttachments),
      }
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
    // PEGAJOSO por sessão, de propósito: as regras de visão entram no turno em
    // que chega a primeira imagem e ficam. Uma imagem do turno 3 deixa uma
    // descrição no histórico que o modelo ainda lê no turno 8 — retirar-lhe as
    // regras aí traz de volta o "não consigo ver imagens" sobre conteúdo que
    // ele TEM. Não sabendo, entrega-se (o `catch` deixa isto a true).
    let sessionHasImage = true
    try {
      const { useChatStore } = await import('../../stores/chatStore')
      const activeSession = useChatStore.getState().getActiveSession()
      sessionMemory = activeSession?.sessionMemory ?? null
      sessionHasImage = (activeSession?.messages ?? []).some(m =>
        m.attachments?.some(a => a.type === 'image'),
      )
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
      generatedPaths,
      readme,
      tmsContent,
      foreignInstructions,
      planContent,
      todoContent,
      projectManifest,
      templateManifest,
      langInstruction,
      modelProfile,
      mcpTools: mcpTools || [],
      coreToolCount,
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

    // Other AI agents' local session history for THIS project (Claude Code,
    // Qwen, Aider, …) — surfaced so the agent can resume another tool's work.
    // Metadata only (existence + count); best-effort, never throws. Resolved
    // here so the dynamicSection() below can stay synchronous.
    let externalAgentSessions: ExternalAgentSessions[] = []
    try {
      externalAgentSessions = await discoverExternalAgentSessions(projectPath)
    } catch { /* non-critical */ }

    // ── Load auxiliary content for the selected auxiliaries ──
    // The selection (metadata) was computed before the cache key; the actual
    // CONTENT is loaded here because the scaffolding/install loader needs
    // ctx.pmDetected (only available after the parallel gather). Auxiliaries
    // that are omitted stay unloaded — their ids appear in the on-demand
    // index below, and the agent can fetch them via `request_context`.
    this.lastAuxiliaryCtx = { pmDetected: ctx.pmDetected, isVanillaWeb: ctx.isVanillaWeb, promptCtx: ctx, loadedSkills }
    // ── Portão de EVIDÊNCIA DO PROJECTO (achado #9, 2026-08-05) ──
    // A entrega inline continua a ser a doutrina (a meia-entrega falhava em
    // silêncio: 0 chamadas a request_context em 34 e em 114 pedidos medidos).
    // O que muda é que a lista deixa de ser cega ao projecto: as secções de
    // design system e as regras de visão só entram quando o PROJECTO (não a
    // tarefa — foi por aí que o Intent Router morreu) mostra a superfície
    // correspondente. Corre aqui e não junto à selecção porque precisa do
    // pkgSummary e da árvore, que só existem depois do gather em paralelo.
    // Ausência de dados não conta como evidência negativa e o portão não é
    // pegajoso — ver projectEvidence.ts. A evidência é a MESMA que decidiu
    // `isVanillaWeb` acima (fonte única), calculada uma vez por build.
    applyEvidenceOmissions(
      auxSelection,
      evidenceOmittedAuxiliaries({
        evidence: projectEvidence,
        sessionHasImage: (signals?.hasImage ?? false) || sessionHasImage,
      }),
      projectEvidence.signals,
    )
    const auxLoadedContent: Record<string, string> = {}
    for (const l of auxSelection.loaded) {
      const body = await this.renderAuxiliaryContent(l.id)
      if (body) auxLoadedContent[l.id] = body
    }
    // Custo REAL do que foi renderizado, em vez da soma dos `estTokens`
    // escritos à mão na meta — ver applyRenderedTokenCounts.
    applyRenderedTokenCounts(auxSelection, auxLoadedContent)
    const dynamicCacheSig = stablePromptHash(JSON.stringify({
      userMessage: userMessage ?? '',
      accessedPaths: accessedPaths ?? [],
      treeString,
      pkgSummary,
      readme,
      projectManifest,
      templateManifest,
      tmsContent,
      // Full foreign body (or a stable hash) — contentLen alone is insufficient:
      // same-length rewrites of AGENTS.md would otherwise serve a stale promptCtx
      // on cache hit (project.docs_full / foreign instructions).
      foreignInstructions: foreignInstructions
        ? {
            kind: foreignInstructions.kind,
            relPath: foreignInstructions.relPath,
            contentHash: stablePromptHash(foreignInstructions.content),
          }
        : null,
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
      this.lastVolatileContext = cached.volatile ?? null
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
      // Imediatamente a seguir ao getDoingTasksSection porque é lá que o
      // "STEP 2b … use the background pattern below" aponta: com a secção
      // gated, essa referência morria no vazio (sessão katondo-streaming).
      getBackgroundInstallSection(ctx),
      // A IDE à volta do agente — aponta o developer às affordances da UI
      // (Preview vs "corre yarn dev", branch chip, fila de tarefas, …).
      getIdeUiGuideSection(),
      getExecutingActionsSection(),
      sharedShellExecutionLoop(),
      getClosedLoopSection(),
      getToolsSection(ctx),
      // Regras de AUTORIA de dev server. Estáticas de propósito: aplicam-se ao
      // escrever os scripts do projecto, portanto antes de existir servidor
      // nenhum — condicioná-las ao servidor estar vivo entregava-as tarde
      // demais. Estavam abaixo da fronteira, coladas ao estado volátil do
      // servidor (2026-07-30).
      getDevServerAuthoringRulesSection(),
      getConstraintsSection(ctx),
      sharedToneAndStyle(),
      sharedOutputEfficiency(),
      sharedContextPreservation(),
      // Memory taxonomy + save/forget discipline. The rules of the
      // memory system are stable across sessions (the data on disk
      // mutates, but the schema/contract is fixed), so this guidance
      // lives in the static block. The actual MEMORY.md indexes are
      // injected below the boundary (they mutate mid-session).
      getMemoryToolsGuidanceSection(),
      // TMS.md full (or AGENTS/CLAUDE compat) — snapshot at run start.
      // In the static prefix so provider prompt-cache reuses it on turns 2+.
      // Agent updates TMS at FINAL CHECKPOINT (see reminder), not as mid-task
      // bookkeeping. Late in the static block so a rare TMS change only
      // invalidates the cache tail after this section.
      getProjectMemorySection(ctx),
      getMemoryGuidanceSection(ctx),
      // Havia aqui o ÍNDICE ON-DEMAND — a lista das secções omitidas para o
      // modelo as pedir com `request_context`. Removido a 2026-08-05: custava
      // 786-1247 tokens POR PEDIDO (mais do que as secções que retinha) e
      // media-se 0 chamadas em 34 e em 114 pedidos. Referência cli-vaz: não há
      // catálogo — o que o projecto justifica vai inline, o resto descobre-se
      // com as ferramentas de ler/procurar/listar.
      // ── Boundary: everything below varies per session / per turn ──
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      // Persistent memory — placed first in the dynamic block because it's
      // the most authoritative per-session context (cross-session facts the
      // developer established). Below the cache boundary because the indexes
      // mutate when the model saves/forgets memories mid-session, so static-
      // caching them would serve stale content.
      dynamicSection('scaffold_workflow', () => auxLoadedContent['scaffold.workflow'] ?? null,
        'scaffold workflow auxiliary is selected only for project-bootstrap tasks'),
      // dev_server saiu daqui (2026-07-28): com o baseline delivery sempre
      // seleccionado, mantê-lo aqui E em dev_server_status duplicava o bloco
      // inteiro no prompt.
      dynamicSection('additional_constraints', () => auxLoadedContent['vision.image_rules'] ?? null,
        'vision-rules auxiliary is selected only when the message carries images'),
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
      dynamicSection('external_agent_sessions', () => buildExternalAgentSessionsSection(externalAgentSessions),
        'other AI agents\' local session dirs for this project — changes as those tools write; null when none found'),
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
      dynamicSection('project_structure', () => getProjectStructureIndexSection(ctx),
        'file tree shifts on every write — fsVersion drives cache key'),
      dynamicSection('project_package_map', () => auxLoadedContent['project.package_map'] ?? null,
        'package summary loaded only for package/build/project planning tasks'),
      dynamicSection('project_entrypoints', () => auxLoadedContent['project.entrypoints'] ?? null,
        'entrypoint summary loaded only for architecture/routing tasks'),
      dynamicSection('agent_runtime_policy', () => auxLoadedContent['agent_runtime.tool_profiles'] ?? null,
        'tool-loading policy; inline while the toolset stays deferred'),
      dynamicSection('delivery_build_scripts', () => auxLoadedContent['delivery.build_scripts'] ?? null,
        'build scripts loaded only for build/test/runtime tasks'),
      // Recently-modified files AFTER the tree: the tree says what exists, this
      // says what was touched last — the likely working set.
      dynamicSection('recent_files', () => getRecentFilesSection(ctx),
        'mtime ordering changes on every save'),
      dynamicSection('readme', () => getReadmeSection(ctx),
        'README.md is developer-editable and used as primary intent signal'),
      // project_memory (TMS full) is above the boundary — static snapshot.
      dynamicSection('active_plan', () => getActivePlanSection(ctx),
        'PLAN.md status flips DRAFT → PENDING APPROVAL → APPROVED mid-session'),
      // Live tracker BEFORE the static TODO.md because the live state is
      // authoritative for "where am I / what's next" — the TODO.md
      // markdown carries the task DECOMPOSITION (which tasks exist, what
      // each requires) but its statuses are stale by design (it's the
      // architect's snapshot, not the implementer's progress). With the
      // live block first the model anchors on the actual state and reads
      // TODO.md as the supporting plan, not the other way around.
      dynamicSection('task_tracker_live', () => this.taskSurface ? null : getTrackerStateSection(ctx),
        'live in-memory tracker mutated by every update_tasks call'),
      dynamicSection('task_list', () => this.taskSurface ? null : getTaskListSection(ctx),
        'TODO.md task statuses flip as the implementation agent progresses'),
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
    // FASE B: corte na fronteira — o ESTÁTICO é devolvido como system prompt;
    // o VOLÁTIL viaja na mensagem do user (o marcador nunca chega ao modelo).
    const boundaryIdx = sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    const staticPrompt = (boundaryIdx >= 0 ? sections.slice(0, boundaryIdx) : sections).join('\n\n')
    this.lastVolatileContext = boundaryIdx >= 0
      ? (sections.slice(boundaryIdx + 1).join('\n\n') || null)
      : null
    this.promptCache.set(cacheKey, { key: cacheKey, prompt: staticPrompt, volatile: this.lastVolatileContext, expiresAt: now + PROMPT_CACHE_TTL_MS, auxiliaryCtx: { pmDetected: ctx.pmDetected, isVanillaWeb: ctx.isVanillaWeb, promptCtx: ctx, loadedSkills } })
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
    return staticPrompt
  }
}

/**
 * Fire-and-forget telemetry for assembled system prompts (technique #22).
 * Emits one event per `buildSystemPrompt` call — including cache hits — so
 * we can compute hit-rate and watch the static/dynamic byte split over
 * time. Never throws, never blocks.
 *
 * Why aggregate (not per-section): firing 30 events per turn is expensive
 * in analytics ingest without a specific question to answer. The aggregate
 * `prompt_built` event answers the practical questions (regression cohort,
 * cache health, MCP/skill load shape) with one event.
 */
function emitPromptBuiltTelemetry(args: {
  mode: 'chat'
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
