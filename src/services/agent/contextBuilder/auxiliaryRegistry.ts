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
  modelRequestedContextSections?: string[]
  requestContextToolCalls?: number
  requestContextSectionsLoaded?: string[]
  requestContextSelectionReason?: Record<string, string>
  requestContextCostTier?: Record<string, ContextCostTier>
  requestContextFallbackUsed?: boolean
  requestContextFallbackFrom?: string[]
  requestContextFallbackTo?: string[]
  requestedButNotLoadedSections?: string[]
  /**
   * Secções BOUNDED que a evidência do projecto não justificou (achado #9).
   * Distintas das omitidas por serem unbounded: estas seriam entregues inline
   * se o projecto tivesse a superfície correspondente. Visíveis no índice
   * on-demand com a razão, e no export.
   */
  evidenceOmittedSections?: string[]
  /** Razão por id, para o índice on-demand e para o export. */
  evidenceOmitReason?: Record<string, string>
  /** Sinais de evidência que suportaram as decisões acima. */
  evidenceSignals?: string[]
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
    id: 'design_system.index',
    domain: 'design_system',
    capability: 'index',
    name: 'Design system index',
    description: 'Compact design-system map: theme files, tokens, recipes, and component pattern locations.',
    scope: 'domain',
    costTier: 'low',
    granularity: 'index',
    whenToUse: 'Use first when the task is visual/theme related but the exact design-system file is unknown.',
    whenNotToUse: 'Do not use for MCP, git, dev-server, backend, or already-localized edits.',
    dependencies: [],
    fallbackTo: ['project.structure_overview'],
    sourceResolver: 'static_expected_files',
    freshnessPolicy: 'stable guidance plus expected file locations',
    expectedFiles: ['src/theme/**', 'src/themes/**', 'src/components/**'],
    summaryAvailable: true,
    fullAvailable: false,
    estTokens: 160,
    type: 'static',
    phase: 1,
  }),
  cx({
    id: 'design_system.semantic_tokens',
    domain: 'design_system',
    capability: 'semantic_tokens',
    name: 'Semantic tokens',
    description: 'How to add or update semantic tokens without loading the whole project tree.',
    scope: 'capability',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use for semantic tokens, theme token names, state tokens, palette aliases, or Chakra semantic token work.',
    whenNotToUse: 'Do not use for routing, MCP, git, dev server, or broad architecture discovery.',
    dependencies: ['design_system.theme_config'],
    fallbackTo: ['design_system.index', 'project.structure_overview'],
    sourceResolver: 'design_system_semantic_tokens',
    freshnessPolicy: 'read expected token/theme files before editing',
    expectedFiles: ['src/theme/**/semantic*', 'src/theme/**/tokens*', 'src/themes/**', 'src/theme/index.ts'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 220,
    type: 'static',
    phase: 1,
  }),
  cx({
    id: 'design_system.theme_config',
    domain: 'design_system',
    capability: 'theme_config',
    name: 'Theme configuration',
    description: 'Theme entrypoints, provider/config expectations, and token wiring guidance.',
    scope: 'capability',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use for theme configuration, Chakra theme setup, semantic token wiring, or provider-level theme changes.',
    whenNotToUse: 'Do not use for ordinary component edits that do not touch theme configuration.',
    dependencies: [],
    fallbackTo: ['design_system.index', 'project.structure_overview'],
    sourceResolver: 'design_system_theme_config',
    freshnessPolicy: 'read theme entrypoint before editing',
    expectedFiles: ['src/theme/index.ts', 'src/theme/**', 'src/themes/**', 'src/components/ui/provider.tsx'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 220,
    type: 'static',
    phase: 1,
  }),
  cx({
    id: 'design_system.brand_palette',
    domain: 'design_system',
    capability: 'brand_palette',
    name: 'Brand palette',
    description: 'Brand color/palette guidance and likely files.',
    scope: 'capability',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use for palette, color, brand color, contrast color, or semantic color naming tasks.',
    whenNotToUse: 'Do not use when the task is not visual or token-related.',
    dependencies: ['design_system.semantic_tokens'],
    fallbackTo: ['design_system.theme_config'],
    sourceResolver: 'design_system_brand_palette',
    freshnessPolicy: 'read palette/token files before editing',
    expectedFiles: ['src/theme/**/colors*', 'src/theme/**/tokens*', 'src/themes/**'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 160,
    type: 'static',
    phase: 1,
  }),
  cx({
    id: 'design_system.chakra_recipes',
    domain: 'design_system',
    capability: 'chakra_recipes',
    name: 'Chakra recipes',
    description: 'Chakra recipe/slot recipe guidance and likely files.',
    scope: 'capability',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use for Chakra recipes, slot recipes, component recipes, variants, or reusable component styling.',
    whenNotToUse: 'Do not use for unrelated React logic or backend changes.',
    dependencies: ['design_system.theme_config'],
    fallbackTo: ['design_system.component_patterns'],
    sourceResolver: 'design_system_chakra_recipes',
    freshnessPolicy: 'read recipe/theme files before editing',
    expectedFiles: ['src/theme/**/recipes*', 'src/theme/**/slot-recipes*', 'src/components/ui/**'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 180,
    type: 'static',
    phase: 1,
  }),
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
    fallbackTo: ['project.structure_overview'],
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
    id: 'ui_patterns',
    domain: 'design_system/ui',
    capability: 'spacing_typography',
    name: 'UI patterns',
    description: 'Taste defaults, spacing, typography, density, and visual restraint guidance.',
    scope: 'domain',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use for visual polish, spacing, typography, density, and UI refinement.',
    whenNotToUse: 'Do not use for MCP audits, git, dev server, backend, or pure config tasks.',
    dependencies: ['design_system.semantic_tokens'],
    fallbackTo: ['design_system.component_patterns'],
    sourceResolver: 'shared_taste_defaults',
    freshnessPolicy: 'stable design guidance',
    expectedFiles: ['src/components/**', 'src/screens/**', 'src/theme/**'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 350,
    type: 'static',
    aliases: ['taste_defaults'],
    phase: 1,
  }),
  cx({
    id: 'project.structure_overview',
    domain: 'project',
    capability: 'structure_overview',
    name: 'Project structure overview',
    description: 'Compact project/file-tree index, not the full tree.',
    scope: 'project',
    costTier: 'low',
    granularity: 'index',
    whenToUse: 'Use when broad architecture or locating an unknown file is required.',
    whenNotToUse: 'Do not use for semantic tokens, localized theme edits, MCP routing, git, or dev-server status.',
    dependencies: [],
    fallbackTo: ['project.structure_full'],
    sourceResolver: 'project_structure_index',
    freshnessPolicy: 'snapshot at turn start',
    expectedFiles: [],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 300,
    type: 'dynamic',
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
    fallbackTo: ['project.structure_overview'],
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
    dependencies: ['project.structure_overview'],
    fallbackTo: ['project.structure_full'],
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
    id: 'project.symbol_index',
    domain: 'project',
    capability: 'symbol_index',
    name: 'Project symbol index',
    description: 'Lightweight file/symbol map with line numbers for targeted Read calls.',
    scope: 'project',
    costTier: 'low',
    granularity: 'index',
    whenToUse: 'Use when you need to locate functions, classes, hooks, components, handlers, or services before reading code.',
    whenNotToUse: 'Do not use as source code or as permission to edit; confirm the exact range with Read before mutating files.',
    dependencies: [],
    fallbackTo: ['project.structure_overview'],
    sourceResolver: 'project_symbol_index',
    freshnessPolicy: 'generated on demand from current files',
    expectedFiles: ['src/**/*.{ts,tsx,js,jsx}', 'src-tauri/src/**/*.rs', '**/*.{go,py,php,rb,java,kt,swift,cs}'],
    summaryAvailable: true,
    fullAvailable: false,
    estTokens: 900,
    type: 'dynamic',
    aliases: ['project_symbol_index', 'symbol_index', 'code_map'],
    phase: 1,
  }),
  cx({
    id: 'project.structure_full',
    domain: 'project',
    capability: 'structure_full',
    name: 'Project structure full',
    description: 'Full file-tree + package summary. Fallback only.',
    scope: 'project',
    costTier: 'high',
    granularity: 'full',
    whenToUse: 'Use only when specific contexts fail, files are unknown, architecture is broad, multiple modules are involved, or dependency mapping spans areas.',
    whenNotToUse: 'Do not use for semantic tokens, localized theme edits, MCP routing, git status, dev-server status, or UI polish with design-system context.',
    dependencies: ['project.structure_overview'],
    fallbackTo: [],
    sourceResolver: 'project_structure_full',
    freshnessPolicy: 'snapshot at turn start',
    expectedFiles: [],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 1500,
    type: 'dynamic',
    aliases: ['project_structure_full'],
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
    fallbackTo: ['project.structure_overview'],
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
    id: 'agent_runtime.memory_context',
    domain: 'agent_runtime',
    capability: 'memory_context',
    name: 'Memory context',
    description: 'Memory indexes and stale-memory policy.',
    scope: 'runtime',
    costTier: 'medium',
    granularity: 'summary',
    whenToUse: 'Use when the task is about agent memory, memories, or project/user memory indexes.',
    whenNotToUse: 'Do not use for project docs unless memory is explicitly involved.',
    dependencies: [],
    fallbackTo: ['project.docs_full'],
    sourceResolver: 'memory_context',
    freshnessPolicy: 'snapshot at turn start',
    expectedFiles: ['MEMORY.md', '.codex/**', '.agents/**'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 500,
    type: 'dynamic',
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
    fallbackTo: ['delivery.changed_files'],
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
    id: 'delivery.changed_files',
    domain: 'delivery/git',
    capability: 'changed_files',
    name: 'Changed files',
    description: 'Recently modified/changed-file working set.',
    scope: 'git',
    costTier: 'low',
    granularity: 'index',
    whenToUse: 'Use with git tasks or when the current changed-file set matters.',
    whenNotToUse: 'Do not use as project structure discovery.',
    dependencies: ['delivery.git_status'],
    fallbackTo: ['project.structure_overview'],
    sourceResolver: 'changed_files',
    freshnessPolicy: 'snapshot at turn start',
    expectedFiles: [],
    summaryAvailable: true,
    fullAvailable: false,
    estTokens: 160,
    type: 'dynamic',
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
    fallbackTo: ['design_system.component_patterns'],
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
  cx({
    id: 'project.docs_full',
    domain: 'project',
    capability: 'project_docs',
    name: 'Project docs',
    description:
      'README + PLAN + TODO. When TMS.md exists, foreign AGENTS/CLAUDE may also appear (dual-case). TMS itself is already in the static system prompt — not repeated here.',
    scope: 'project-doc',
    costTier: 'high',
    granularity: 'full',
    whenToUse:
      'Use when README, PLAN.md, or TODO.md content is needed (or dual-case foreign instructions not already in the system prompt).',
    whenNotToUse:
      'Do not use only to re-read TMS.md or sole AGENTS/CLAUDE (already in system prompt). Do not use as general project orientation when structure/git is enough.',
    dependencies: [],
    fallbackTo: ['project.structure_overview'],
    sourceResolver: 'project_docs_full',
    freshnessPolicy: 'snapshot at turn start',
    expectedFiles: ['README.md', 'TMS.md', 'AGENTS.md', 'CLAUDE.md', 'PLAN.md', 'TODO.md'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 2000,
    type: 'project-doc',
    aliases: ['project_docs_full'],
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
  'design_system.semantic_tokens',
  'design_system.theme_config',
  'design_system.brand_palette',
  'design_system.chakra_recipes',
  'design_system.component_patterns',
  'ui_patterns',
  'project.package_map',
  'project.entrypoints',
  'delivery.build_scripts',
  'agent_runtime.mcp_routing',
  'agent_runtime.tool_profiles',
  'vision.image_rules',
]

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
    modelRequestedContextSections: [],
    requestContextToolCalls: 0,
    requestContextSectionsLoaded: [],
    requestContextSelectionReason: {},
    requestContextCostTier: {},
    requestContextFallbackUsed: false,
    requestContextFallbackFrom: [],
    requestContextFallbackTo: [],
    requestedButNotLoadedSections: [],
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
 * Retira da entrega inline as secções que a EVIDÊNCIA DO PROJECTO não
 * justifica (achado #9 — ver `projectEvidence.ts` para o critério e para as
 * duas regras que evitam a falha silenciosa).
 *
 * Muta a selecção no sítio, de propósito: `contextBuilder` já guardou a
 * referência em `lastAuxiliarySelection`, e a telemetria (`payloadInspector`)
 * lê `loaded` / `omitted` / `loadedTokens` daí. Reescrever um objecto novo aqui
 * deixaria a telemetria a olhar para a selecção PRÉ-filtro — exactamente o modo
 * de falha que este achado documenta (um mecanismo que parece activo e não
 * está). A chave de cache do prompt não sofre: `dynamicCacheSig` inclui o
 * `auxLoadedContent` e o índice on-demand, ambos já pós-filtro.
 */
export function applyEvidenceOmissions(
  selection: AuxiliarySelection,
  omissions: Array<{ id: string; reason: string }>,
  signals: string[] = [],
): AuxiliarySelection {
  const byId = new Map(omissions.map(o => [resolveAuxiliaryId(o.id), o.reason]))
  if (byId.size === 0) {
    selection.evidenceSignals = signals
    return selection
  }

  const kept: AuxiliaryLoadResult[] = []
  const dropped: string[] = []
  const reasons: Record<string, string> = {}

  for (const entry of selection.loaded) {
    const reason = byId.get(entry.id)
    if (!reason) {
      kept.push(entry)
      continue
    }
    const meta = getAuxiliaryMeta(entry.id)
    dropped.push(entry.id)
    reasons[entry.id] = reason
    selection.omitted.push({
      id: entry.id,
      name: entry.name,
      description: meta?.description ?? entry.name,
      reason: `project evidence: ${reason}`,
      estTokens: entry.tokens,
      domain: entry.domain,
      capability: entry.capability,
      scope: entry.scope,
      costTier: entry.costTier,
      granularity: entry.granularity,
      whenToUse: meta?.whenToUse ?? '',
      whenNotToUse: meta?.whenNotToUse ?? '',
      fallbackTo: meta?.fallbackTo ?? [],
    })
  }

  if (dropped.length === 0) {
    selection.evidenceSignals = signals
    return selection
  }

  selection.loaded = kept
  selection.loadedTokens = kept.reduce((sum, l) => sum + l.tokens, 0)
  selection.savingsTokens = selection.totalAvailableTokens - selection.loadedTokens
  selection.autoLoadedSystemSections = kept.map(l => l.id)
  selection.evidenceOmittedSections = dropped
  selection.evidenceOmitReason = reasons
  selection.evidenceSignals = signals
  // O plano tem de contar a mesma história que a entrega: sem isto, o cabeçalho
  // do índice on-demand anunciava "Selected inline: …" a listar secções que já
  // não vão no prompt.
  const droppedSet = new Set(dropped)
  selection.contextPlan = {
    ...selection.contextPlan,
    selectedContexts: selection.contextPlan.selectedContexts.filter(
      id => !droppedSet.has(resolveAuxiliaryId(id)),
    ),
  }
  return selection
}

/**
 * Substitui os `estTokens` declarados pelo custo REAL do corpo renderizado.
 *
 * `auxiliaryContextTokens` era a soma das estimativas escritas à mão na meta —
 * o achado #9 foi medido com elas e desviavam-se do real (component_patterns:
 * 650 declarados, 864 reais). Uma telemetria de custo que não mede o custo faz
 * a próxima auditoria discutir o número errado.
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
  selection.savingsTokens = Math.max(0, selection.totalAvailableTokens - total)
  return selection
}

export function buildOnDemandIndex(selection: AuxiliarySelection): string | null {
  const omitted = selection.omitted
  if (omitted.length === 0) return null

  const candidateSet = new Set(selection.contextPlanCandidateSections ?? [])
  const evidenceSet = new Set(selection.evidenceOmittedSections ?? [])
  const evidenceOmitted = omitted.filter(o => evidenceSet.has(o.id))
  const candidates = omitted.filter(o => !evidenceSet.has(o.id) && candidateSet.has(o.id))
  const fallbackOnly = omitted.filter(o => !evidenceSet.has(o.id) && !candidateSet.has(o.id) && (o.granularity === 'full' || o.costTier === 'high'))
  const available = omitted.filter(o => !evidenceSet.has(o.id) && !candidateSet.has(o.id) && !fallbackOnly.includes(o))

  const candidateLines = candidates.map((o) =>
    `- \`${o.id}\` [candidate; ${o.granularity}; ${o.costTier}] — ${o.description}`,
  )

  // Uma linha POR SECÇÃO, com a descrição da meta. A versão anterior listava
  // só ids agrupados por domínio ("- design_system: `a`, `b`, `c`") — medido
  // na sessão momenu-fact de 02-08: 0 chamadas a request_context em 34
  // pedidos. Ids nus não dão ao modelo matéria para DECIDIR; a descrição de
  // uma linha custa ~200 tokens no total e é o que torna o índice utilizável.
  const byDomain = new Map<string, string[]>()
  for (const o of available) {
    const lines = byDomain.get(o.domain) ?? []
    lines.push(`  - \`${o.id}\` — ${o.description}`)
    byDomain.set(o.domain, lines)
  }
  const domainLines = Array.from(byDomain.entries()).flatMap(
    ([domain, lines]) => [`- ${domain}:`, ...lines],
  )

  const fallbackLine = fallbackOnly.length
    ? `Fallback-only broad/high-cost contexts: ${fallbackOnly.map(o => `\`${o.id}\``).join(', ')}.`
    : null
  const hasSymbolIndex = omitted.some(o => o.id === 'project.symbol_index')
  const symbolIndexLine = hasSymbolIndex
    ? 'Navigation shortcut: request `project.symbol_index` when you need to locate functions/classes/components/hooks/handlers/services before choosing a Read range. It is an index only; verify source with Read before editing.'
    : null

  return [
    '# Auxiliary context (on-demand)',
    '',
    `Context plan: ${selection.contextPlan.taskDomain}; required: ${selection.contextPlan.requiredCapabilities.join(', ') || 'none'}; minimum: ${selection.contextPlan.minimumContextNeeded}; fallback risk: ${selection.contextPlan.fallbackRisk}.`,
    `Selected inline: ${selection.contextPlan.selectedContexts.length ? selection.contextPlan.selectedContexts.map(id => `\`${resolveAuxiliaryId(id)}\``).join(', ') : 'none'}.`,
    '',
    // A política de uso vive AQUI, no cabeçalho do índice — não numa secção
    // on-demand. A `agent_runtime.request_context_policy` (removida) era
    // circular: as instruções de quando usar o request_context só chegavam a
    // quem já soubesse usá-lo. Uma política que o modelo não vê não existe.
    // Desde a doutrina full-delivery (2026-08-03) só as secções UNBOUNDED
    // chegam aqui — o resto é entregue inline.
    'Sections are omitted from the prompt when they are unbounded, or when this project shows no evidence that they apply. To load one, call the `request_context` tool with its id — the content comes back as a tool result in the same turn. This is expected use, not a failure mode: when a section below matches the task, request it BEFORE falling back to broad exploration.',
    'Typical moments: you need to locate a function/class/component/hook by name → `project.symbol_index`; broad architecture or unknown file layout → `project.structure_full`; README/PLAN/TODO content → `project.docs_full`; the task is about agent memory → `agent_runtime.memory_context`.',
    'Call once per id — content already returned does not need re-requesting.',
    ...(symbolIndexLine ? [symbolIndexLine] : []),
    '',
    // Grupo próprio e no topo: estas seriam entregues inline e foram retidas
    // por evidência do PROJECTO, não por serem caras. Se a tarefa contrariar a
    // evidência (ex.: introduzir a primeira UI num backend), é aqui que o
    // modelo vê o que lhe falta — e a razão, para poder discordar dela.
    ...(evidenceOmitted.length
      ? [
          'Withheld for lack of project evidence — request any of these if the task contradicts the evidence (e.g. you are about to add the project\'s first UI):',
          ...evidenceOmitted.map(o =>
            `- \`${o.id}\` — ${o.description} (${(selection.evidenceOmitReason ?? {})[o.id] ?? o.reason})`,
          ),
          '',
        ]
      : []),
    ...(candidateLines.length ? ['Candidate contexts:', ...candidateLines, ''] : []),
    ...(domainLines.length ? ['Other available contexts:', ...domainLines, ''] : []),
    ...(fallbackLine ? [fallbackLine] : []),
  ].join('\n')
}
