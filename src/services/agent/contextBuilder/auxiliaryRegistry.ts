/**
 * Strategic Context Registry for on-demand system context.
 *
 * Context is organised by knowledge domain and capability, not by one-off
 * local text matching. Selection follows the smallest-sufficient-context rule:
 * specific capability > domain summary > broad project context.
 */

/**
 * Perfis de prompt COM PRODUTOR. Eram nove; seis (`core`, `analysis_readonly`,
 * `frontend_ui`, `scaffold_project`, `deploy_publish`, `auth_database`) foram
 * apagados a 2026-07-30 — nada os conseguia seleccionar desde o pivot dev-only
 * e a remoção do Intent Router, mas cada um trazia a sua tabela de contexto
 * escrita, o que os fazia ler como capacidades vivas. Duas auditorias
 * anteriores documentaram-nos como "RESERVADOS" em vez de os remover; a nota
 * de 07-29 di-lo bem: "é exactamente como um perfil morto continua a parecer
 * vivo".
 *
 * Produtores actuais — se acrescentares um valor aqui, acrescenta o produtor
 * no mesmo commit:
 *   - heurística inline em contextBuilder → 'vision' (há imagem) | 'default_task' (resto)
 *   - `intentOverride` → 'project_bootstrap' (/init e o preflight de TMS)
 */
export type PromptProfile =
  | 'default_task'
  | 'project_bootstrap'
  | 'vision'

export type AuxiliaryType =
  | 'static'
  | 'dynamic'
  | 'skill'
  | 'project-doc'
  | 'toolset'
  | 'provider-specific'

export type ContextCostTier = 'low' | 'medium' | 'high'
export type ContextGranularity = 'index' | 'summary' | 'full'
export type ContextFallbackRisk = 'low' | 'medium' | 'high'

export interface AuxiliaryMeta {
  /** Stable id used by `request_context({ auxiliary: id })`. */
  id: string
  /** Domain-qualified knowledge area. */
  domain: string
  /** Capability inside the domain. */
  capability: string
  /** Human-readable name shown in the on-demand index. */
  name: string
  /** One-line description shown in the on-demand index. */
  description: string
  /** Scope of the context: capability, domain, project, runtime, etc. */
  scope: string
  costTier: ContextCostTier
  granularity: ContextGranularity
  whenToUse: string
  whenNotToUse: string
  dependencies: string[]
  fallbackTo: string[]
  sourceResolver: string
  freshnessPolicy: string
  expectedFiles: string[]
  summaryAvailable: boolean
  fullAvailable: boolean
  /** Rough token cost when loaded (ceil(chars/3) of the typical body). */
  estTokens: number
  type: AuxiliaryType
  /** Compatibility aliases accepted by request_context. */
  aliases?: string[]
  /** 1 = loadable now; 2 = registered for later/no loader. */
  phase: 1 | 2
}

export interface AuxiliaryLoadResult {
  id: string
  name: string
  reason: string
  tokens: number
  domain: string
  capability: string
  scope: string
  costTier: ContextCostTier
  granularity: ContextGranularity
}

export interface AuxiliaryOmitResult {
  id: string
  name: string
  description: string
  reason: string
  estTokens: number
  domain: string
  capability: string
  scope: string
  costTier: ContextCostTier
  granularity: ContextGranularity
  whenToUse: string
  whenNotToUse: string
  fallbackTo: string[]
}

export interface ContextPlan {
  taskDomain: string
  requiredCapabilities: string[]
  minimumContextNeeded: ContextGranularity
  candidateContexts: string[]
  selectedContexts: string[]
  /** Contexts the planner considered but did NOT select (audit). Derived
   *  from candidateContexts minus selectedContexts when the model omits it. */
  rejectedContexts?: string[]
  fallbackRisk: ContextFallbackRisk
  reason: string
}

/**
 * Classificação de um plano de contexto. Vivia no `contextPlanner.ts` — 271
 * linhas cujo runtime (parser + validador do plano devolvido por um modelo)
 * deixou de ter chamadores quando o Context Planner foi desligado. O ficheiro
 * foi apagado a 2026-07-30; só este tipo estava vivo, e só porque o
 * contextBuilder o usava para carimbar o plano determinista.
 *
 * `source` é 'deterministic' hoje (2026-08-03 — antes dizia 'fallback', que
 * implicava um planner falhado; não há planner, a selecção determinística É
 * o desenho). 'fallback' fica no tipo para compat com exports antigos; se
 * algum dia voltar um planner por modelo, é aqui que 'model' volta a ser
 * possível.
 */
export interface ContextPlanClassification {
  plan: ContextPlan
  source: 'model' | 'deterministic' | 'fallback'
  modelTier?: 'utility' | 'code'
  attempts?: number
  confidence: 'high' | 'medium' | 'low' | 'none'
  reason: string
  error?: string
  fallbackReason?: string
  diagnostics?: RouterDiagnostics
}

export interface AuxiliarySelection {
  profile: PromptProfile
  contextPlan: ContextPlan
  loaded: AuxiliaryLoadResult[]
  omitted: AuxiliaryOmitResult[]
  loadedTokens: number
  totalAvailableTokens: number
  savingsTokens: number
  autoLoadedSystemSections?: string[]
  contextPlanCandidateSections?: string[]
  readOnly: boolean
  reason: string
  routerSource: 'model' | 'fallback' | 'keyword'
  routerConfidence: 'high' | 'medium' | 'low' | 'none'
  routerError?: string
  routerDiagnostics?: RouterDiagnostics
  // ── Context Planner telemetry (auditable status) ──
  // Mirrors the ContextPlanClassification so the export can prove whether
  // the utility-model planner produced a valid plan ('parsed') or fell back
  // ('fallback'), and surface the raw output / error for diagnosis. The
  // taskDomain / requiredCapabilities / selectedContexts ride on
  // `contextPlan`; rejectedContexts and selectionReason are surfaced here.
  contextPlannerStatus?: 'parsed' | 'deterministic' | 'fallback'
  contextPlannerSource?: 'model' | 'deterministic' | 'fallback'
  contextPlannerModel?: 'utility' | 'code'
  contextPlannerError?: string
  contextPlannerRawOutput?: string
  contextPlannerFallbackReason?: string
  contextPlannerRejectedContexts?: string[]
  contextPlannerSelectionReason?: string
}

export interface RouterDiagnostics {
  url: string
  appCheckPresent: boolean
  httpStatus: number
  servedModel?: string
  configKey?: string
  contentType?: string
  rawBodyPreview?: string
  contentPreview?: string
  parseError?: string
}


const cx = (meta: AuxiliaryMeta): AuxiliaryMeta => meta

// NOTE: per-section tms.* auxiliaries (tms.commands, tms.agent_rules, …) were
// removed. TMS.md is injected in full in the static system prompt (provider
// prompt-cache). Section-level request_context was redundant and taught the
// model to re-fetch content it already has. Prefer project.docs_full when
// README/PLAN/TODO (or dual-case foreign instructions) are needed.

export const AUXILIARY_METAS: AuxiliaryMeta[] = [
  cx({
    id: 'design_system.component_patterns',
    domain: 'design_system',
    capability: 'component_patterns',
    name: 'Component patterns',
    description: 'Compact UI/component design baseline for visual improvements.',
    scope: 'domain',
    costTier: 'medium',
    granularity: 'summary',
    whenToUse: 'Use for explicit UI/design/layout/visual polish/component styling work.',
    whenNotToUse: 'Do not use just because a file is .tsx or under screens/account.',
    dependencies: ['design_system.semantic_tokens'],
    fallbackTo: [],
    sourceResolver: 'shared_ui_baseline_core',
    freshnessPolicy: 'stable design guidance',
    expectedFiles: ['src/components/**', 'src/screens/**', 'src/theme/**'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 650,
    type: 'static',
    aliases: ['ui_baseline_full'],
    phase: 1,
  }),
  cx({
    id: 'project.package_map',
    domain: 'project',
    capability: 'package_map',
    name: 'Package map',
    description: 'Package manager, scripts, dependencies, aliases, and package shape.',
    scope: 'project',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use for package scripts, dependency map, build command discovery, or project package shape.',
    whenNotToUse: 'Do not use when git/dev-server/theme-specific context is sufficient.',
    dependencies: [],
    fallbackTo: [],
    sourceResolver: 'package_summary',
    freshnessPolicy: 'snapshot at turn start',
    expectedFiles: ['package.json', 'vite.config.*', 'tsconfig.json'],
    summaryAvailable: true,
    fullAvailable: false,
    estTokens: 220,
    type: 'dynamic',
    phase: 1,
  }),
  cx({
    id: 'project.entrypoints',
    domain: 'project',
    capability: 'entrypoints',
    name: 'Project entrypoints',
    description: 'Likely app entrypoints, aliases, and routing/config entry files.',
    scope: 'project',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use for architecture mapping or when the task needs app entrypoints.',
    whenNotToUse: 'Do not use for already-localized file edits.',
    dependencies: [],
    fallbackTo: [],
    sourceResolver: 'project_entrypoints',
    freshnessPolicy: 'snapshot at turn start',
    expectedFiles: ['src/main.tsx', 'src/App.tsx', 'src/index.ts', 'src/routes/**'],
    summaryAvailable: true,
    fullAvailable: false,
    estTokens: 220,
    type: 'dynamic',
    phase: 1,
  }),
  cx({
    id: 'agent_runtime.mcp_routing',
    domain: 'agent_runtime',
    capability: 'mcp_routing',
    name: 'MCP routing',
    description: 'Detailed MCP usage and routing policy.',
    scope: 'runtime',
    costTier: 'medium',
    granularity: 'summary',
    whenToUse: 'Use for MCP audits, MCP tool routing, external state/side effects, or connector questions.',
    whenNotToUse: 'Do not use for design tokens, git, dev server, or project architecture unless MCP files must be located.',
    dependencies: [],
    fallbackTo: [],
    sourceResolver: 'mcp_routing_detail',
    freshnessPolicy: 'snapshot of connected tools at turn start',
    expectedFiles: ['src/services/mcp/**', 'src/services/agent/toolPolicy.ts'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 600,
    type: 'dynamic',
    aliases: ['mcp_routing_detail'],
    phase: 1,
  }),
  // `agent_runtime.request_context_policy` foi REMOVIDA (2026-08-03): era
  // circular — a política de uso do request_context só chegava a quem já
  // soubesse usá-lo. O conteúdo vive agora inline no cabeçalho do índice
  // on-demand (buildOnDemandIndex). Medido na sessão momenu-fact de 02-08:
  // 0 chamadas a request_context em 34 pedidos com a política trancada aqui.
  cx({
    id: 'agent_runtime.tool_profiles',
    domain: 'agent_runtime',
    capability: 'tool_profiles',
    name: 'Tool loading',
    description: 'How the toolset is assembled: frozen local tools + deferred MCP definitions loaded on demand.',
    scope: 'runtime',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use when auditing or changing how tool definitions are assembled, deferred, or loaded on demand.',
    whenNotToUse: 'Do not use for external MCP routing unless tool loading behavior is the subject.',
    dependencies: [],
    fallbackTo: [],
    sourceResolver: 'tool_profiles_summary',
    freshnessPolicy: 'stable code policy',
    expectedFiles: ['src/services/agent/toolPolicy.ts', 'src/services/agent/toolExecutor.ts'],
    summaryAvailable: true,
    fullAvailable: false,
    estTokens: 180,
    type: 'static',
    phase: 1,
  }),
  cx({
    id: 'delivery.dev_server',
    domain: 'delivery/runtime',
    capability: 'dev_server',
    name: 'Dev server',
    description: 'Dev-server rules, preview/browser runtime status, and server troubleshooting.',
    scope: 'runtime',
    costTier: 'medium',
    granularity: 'summary',
    whenToUse: 'Use for preview/browser/runtime/dev-server/Vite server failures.',
    whenNotToUse: 'Do not use for git, design tokens, MCP, or static code-only changes.',
    dependencies: ['delivery.build_scripts'],
    fallbackTo: ['project.package_map'],
    sourceResolver: 'dev_server_status_detail',
    freshnessPolicy: 'live snapshot at turn start',
    expectedFiles: ['package.json', 'vite.config.*'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 350,
    type: 'dynamic',
    aliases: ['dev_server_status_detail'],
    phase: 1,
  }),
  cx({
    id: 'delivery.build_scripts',
    domain: 'delivery/runtime',
    capability: 'build',
    name: 'Build scripts',
    description: 'Build/test/package scripts and package-manager summary.',
    scope: 'runtime',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use for build/test/package command discovery or build failures.',
    whenNotToUse: 'Do not use for git commits unless build scripts are requested.',
    dependencies: ['project.package_map'],
    fallbackTo: ['project.package_map'],
    sourceResolver: 'build_scripts',
    freshnessPolicy: 'snapshot at turn start',
    expectedFiles: ['package.json', 'yarn.lock', 'vite.config.*'],
    summaryAvailable: true,
    fullAvailable: false,
    estTokens: 220,
    type: 'dynamic',
    phase: 1,
  }),
  cx({
    id: 'delivery.git_status',
    domain: 'delivery/git',
    capability: 'git_status',
    name: 'Git status',
    description: 'Branch, upstream state, changed files, and recent commits snapshot.',
    scope: 'git',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use for git, commit, branch, pull, push, diff, merge, tag, or rebase tasks.',
    whenNotToUse: 'Do not use for dev server, design system, MCP, or backend bugfixes unless git is requested.',
    dependencies: [],
    fallbackTo: [],
    sourceResolver: 'git_status_detail',
    freshnessPolicy: 'snapshot at turn start',
    expectedFiles: ['.git'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 520,
    type: 'dynamic',
    aliases: ['git_status_detail'],
    phase: 1,
  }),
  cx({
    id: 'scaffold.workflow',
    domain: 'project/scaffold',
    capability: 'scaffold_workflow',
    name: 'Scaffolding workflow',
    description: 'New-project scaffolding and install workflow.',
    scope: 'project',
    costTier: 'medium',
    granularity: 'summary',
    whenToUse: 'Use for creating/scaffolding new projects or installing dependencies as part of project creation.',
    whenNotToUse: 'Do not use for local bugfixes or existing-project token edits.',
    dependencies: ['project.package_map'],
    fallbackTo: ['delivery.build_scripts'],
    sourceResolver: 'scaffolding_install',
    freshnessPolicy: 'stable policy plus detected package manager',
    expectedFiles: ['package.json'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 1200,
    type: 'static',
    aliases: ['scaffolding_install'],
    phase: 1,
  }),
  cx({
    id: 'vision.image_rules',
    domain: 'vision',
    capability: 'image_rules',
    name: 'Vision rules',
    description: 'How to handle image/screenshot descriptions from the vision pipeline.',
    scope: 'media',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use when images, screenshots, mockups, or diagrams are part of the task.',
    whenNotToUse: 'Do not use for text-only tasks.',
    dependencies: [],
    fallbackTo: [],
    sourceResolver: 'vision_rules',
    freshnessPolicy: 'stable policy',
    expectedFiles: [],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 200,
    type: 'static',
    aliases: ['vision_rules'],
    phase: 1,
  }),
]

const META_BY_ID = new Map(AUXILIARY_METAS.map(meta => [meta.id, meta]))
const ALIAS_TO_ID = new Map<string, string>()
for (const meta of AUXILIARY_METAS) {
  for (const alias of meta.aliases ?? []) ALIAS_TO_ID.set(alias, meta.id)
}

export function resolveAuxiliaryId(id: string): string {
  return ALIAS_TO_ID.get(id) ?? id
}

export function getAuxiliaryMeta(id: string): AuxiliaryMeta | undefined {
  return META_BY_ID.get(resolveAuxiliaryId(id))
}

function unique(ids: string[]): string[] {
  return Array.from(new Set(ids))
}

/**
 * Secções BOUNDED entregues inline por defeito (doutrina full-delivery,
 * 2026-08-03). A meia-entrega falhava em silêncio: na sessão momenu-fact de
 * 02-08, 0 chamadas a request_context em 34 pedidos — as secções omitidas
 * nunca serviram para nada, e com ~96% de cache-hit medido o custo marginal
 * de as entregar é ~10% do preço nominal. Ficam ON-DEMAND apenas as
 * unbounded (project.structure_full, project.docs_full, project.symbol_index)
 * e agent_runtime.memory_context (duplicaria as secções estáticas de memória
 * do prompt — ver renderAuxiliaryContent).
 *
 * ESTA LISTA NÃO É A ENTREGA FINAL (2026-08-05, achado #9). É o candidato
 * máximo: depois dela corre um portão de EVIDÊNCIA DO PROJECTO que retira as
 * secções de design system num repo sem UI/tema/Chakra e as regras de visão
 * numa sessão sem imagens — ver `projectEvidence.ts` e `applyEvidenceOmissions`
 * abaixo. Medido antes de mudar: as seis secções de design system são texto
 * estático e custavam ~1 656 tokens REAIS por pedido, mesmo num backend puro.
 * O portão depende do PROJECTO e nunca da tarefa (foi por classificar a tarefa
 * que o Intent Router morreu), o que ele retém fica visível no índice
 * on-demand com a razão, e um projecto vazio continua a receber tudo.
 */
// Fora da lista, de propósito (não são meia-entrega — já chegam por outra via
// ou duplicariam): `delivery.changed_files` (a secção recent_files entrega o
// mesmo bloco em todos os runs), `project.structure_overview` (é o fallback
// permanente da secção project_structure), `scaffold.workflow` (o protocolo
// de install já vive no bloco estático; o workflow completo é só para
// bootstrap), `agent_runtime.memory_context` (duplicaria as secções estáticas
// de memória).
export const BOUNDED_INLINE_CONTEXTS: string[] = [
  'design_system.component_patterns',
  'project.package_map',
  'project.entrypoints',
  'delivery.build_scripts',
  'agent_runtime.mcp_routing',
  'agent_runtime.tool_profiles',
]

/**
 * As regras de visão só entram quando há (ou houve) uma imagem na sessão —
 * a forma `string | null` do cli-vaz, que devolve null para a secção MCP
 * quando não há servidores MCP. Sem imagem, o texto não tem referente.
 *
 * PEGAJOSO por sessão de propósito: uma imagem do turno 3 deixa uma descrição
 * no histórico que o modelo ainda lê no turno 8 — retirar-lhe as regras aí
 * traz de volta o "não consigo ver imagens" sobre conteúdo que ele TEM.
 */
export function inlineContextsForSession(sessionHasImage: boolean): string[] {
  return sessionHasImage
    ? [...BOUNDED_INLINE_CONTEXTS, 'vision.image_rules']
    : BOUNDED_INLINE_CONTEXTS
}

export function fallbackContextPlanForProfile(profile: PromptProfile): ContextPlan {
  if (profile === 'project_bootstrap') {
    return {
      taskDomain: 'project_bootstrap',
      requiredCapabilities: ['project_map', 'tms_write'],
      minimumContextNeeded: 'index',
      candidateContexts: [],
      selectedContexts: [],
      fallbackRisk: 'low',
      reason: 'TMS bootstrap profile: inspect only focused project files and write TMS.md before resuming the user request.',
    }
  }

  if (profile === 'vision') {
    return {
      taskDomain: 'vision',
      requiredCapabilities: ['image_rules'],
      minimumContextNeeded: 'summary',
      candidateContexts: [],
      selectedContexts: BOUNDED_INLINE_CONTEXTS,
      fallbackRisk: 'low',
      reason: 'Full delivery: bounded sections inline; only unbounded contexts stay on-demand.',
    }
  }

  return {
    taskDomain: 'default_task',
    requiredCapabilities: [],
    minimumContextNeeded: 'summary',
    candidateContexts: [],
    selectedContexts: BOUNDED_INLINE_CONTEXTS,
    fallbackRisk: 'low',
    reason: 'Full delivery: bounded sections inline; only unbounded contexts stay on-demand.',
  }
}

export function selectAuxiliaries(
  profile: PromptProfile,
  userMessage: string | undefined,
  readOnlyHint?: boolean,
  reason?: string,
  routerInfo?: { source: 'model' | 'fallback' | 'keyword'; confidence?: 'high' | 'medium' | 'low' | 'none'; error?: string; diagnostics?: RouterDiagnostics },
  contextPlanOverride?: ContextPlan,
  plannerInfo?: { status: 'parsed' | 'deterministic' | 'fallback'; source?: 'model' | 'deterministic' | 'fallback'; modelTier?: 'utility' | 'code'; error?: string; rawOutput?: string; fallbackReason?: string; selectionReason?: string },
): AuxiliarySelection {
  void userMessage
  const phase1 = AUXILIARY_METAS.filter((m) => m.phase === 1)
  const contextPlan = contextPlanOverride ?? fallbackContextPlanForProfile(profile)
  const selectedIds = new Set(contextPlan.selectedContexts.map(resolveAuxiliaryId))
  const candidateIds = unique(contextPlan.candidateContexts.map(resolveAuxiliaryId))

  const loaded: AuxiliaryLoadResult[] = []
  const omitted: AuxiliaryOmitResult[] = []
  let loadedTokens = 0
  let totalAvailableTokens = 0

  for (const meta of phase1) {
    totalAvailableTokens += meta.estTokens
    const planMatch = selectedIds.has(meta.id)
    const shouldLoad = planMatch

    if (shouldLoad) {
      loaded.push({
        id: meta.id,
        name: meta.name,
        reason: `model context plan selected for ${contextPlan.taskDomain}: ${meta.capability}`,
        tokens: meta.estTokens,
        domain: meta.domain,
        capability: meta.capability,
        scope: meta.scope,
        costTier: meta.costTier,
        granularity: meta.granularity,
      })
      loadedTokens += meta.estTokens
    } else {
      omitted.push({
        id: meta.id,
        name: meta.name,
        description: meta.description,
        reason: candidateIds.includes(meta.id)
          ? `candidate for ${contextPlan.taskDomain}, not minimum context`
          : `not required by context plan for ${contextPlan.taskDomain}`,
        estTokens: meta.estTokens,
        domain: meta.domain,
        capability: meta.capability,
        scope: meta.scope,
        costTier: meta.costTier,
        granularity: meta.granularity,
        whenToUse: meta.whenToUse,
        whenNotToUse: meta.whenNotToUse,
        fallbackTo: meta.fallbackTo,
      })
    }
  }

  return {
    profile,
    contextPlan,
    loaded,
    omitted,
    loadedTokens,
    totalAvailableTokens,
    savingsTokens: totalAvailableTokens - loadedTokens,
    autoLoadedSystemSections: loaded.map((l) => l.id),
    contextPlanCandidateSections: candidateIds,
    readOnly: readOnlyHint === true,
    reason: reason ?? `context planner (taskDomain=${contextPlan.taskDomain})`,
    routerSource: routerInfo?.source ?? 'keyword',
    routerConfidence: routerInfo?.confidence ?? 'none',
    routerError: routerInfo?.error,
    routerDiagnostics: routerInfo?.diagnostics,
    contextPlannerStatus:
      plannerInfo?.status ?? (contextPlanOverride ? 'parsed' : 'fallback'),
    contextPlannerSource:
      plannerInfo?.source ?? (contextPlanOverride ? 'model' : 'fallback'),
    contextPlannerModel: plannerInfo?.modelTier,
    contextPlannerError: plannerInfo?.error,
    contextPlannerRawOutput: plannerInfo?.rawOutput,
    contextPlannerFallbackReason: plannerInfo?.fallbackReason,
    // Authoritative audit set: every candidate the planner exposed that was
    // NOT selected. Derived from candidateIds/selectedIds (the actual gating
    // decision) rather than the model's declared rejectedContexts, so the
    // audit reflects what the selector truly loaded vs. held back.
    contextPlannerRejectedContexts: candidateIds.filter((id) => !selectedIds.has(id)),
    contextPlannerSelectionReason: plannerInfo?.selectionReason ?? contextPlan.reason,
  }
}

/**
 * Substitui os `estTokens` declarados pelo custo REAL do corpo renderizado.
 *
 * `auxiliaryContextTokens` era a soma das estimativas escritas à mão na meta —
 * o achado #9 foi medido com elas e desviavam-se do real (component_patterns:
 * 650 declarados, 864 reais). Uma telemetria de custo que não mede o custo faz
 * a próxima auditoria discutir o número errado.
 *
 * `savingsTokens` NÃO é tocado aqui de propósito: continua a ser a soma dos
 * ESTIMADOS das secções omitidas (não foram renderizadas, portanto não há
 * corpo para medir). Misturar as duas unidades na mesma subtracção daria um
 * número que não é nem estimativa nem medição.
 */
export function applyRenderedTokenCounts(
  selection: AuxiliarySelection,
  rendered: Record<string, string>,
): AuxiliarySelection {
  let total = 0
  for (const entry of selection.loaded) {
    const body = rendered[entry.id]
    if (typeof body === 'string') entry.tokens = Math.ceil(body.length / 3)
    total += entry.tokens
  }
  selection.loadedTokens = total
  return selection
}
