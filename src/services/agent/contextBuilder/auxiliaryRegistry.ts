/**
 * Strategic Context Registry for on-demand system context.
 *
 * Context is organised by knowledge domain and capability, not by one-off
 * local text matching. Selection follows the smallest-sufficient-context rule:
 * specific capability > domain summary > broad project context.
 */

export type PromptProfile =
  | 'core'
  | 'bugfix_local'
  | 'project_bootstrap'
  | 'analysis_readonly'
  | 'frontend_ui'
  | 'scaffold_project'
  | 'deploy_publish'
  | 'auth_database'
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
  /** Profiles that may auto-include this auxiliary inline. */
  profiles: PromptProfile[]
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
  toolGroups?: Array<'FILE_OPS' | 'SHELL' | 'WEB' | 'SUBAGENT' | 'MEMORY' | 'PROVISION'>
  fallbackRisk: ContextFallbackRisk
  reason: string
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
  contextPlannerStatus?: 'parsed' | 'fallback'
  contextPlannerSource?: 'model' | 'fallback'
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

export interface IntentSignals {
  hasImage?: boolean
  mentionedFiles?: string[]
}

export function classifyPromptIntent(
  _userMessage: string | undefined,
  signals?: IntentSignals,
): PromptProfile {
  const hasImage = signals?.hasImage ?? false

  if (hasImage) {
    return 'vision'
  }
  // Intent routing is model-owned. This function is a conservative fallback
  // for paths that cannot call the router; do not infer from free text here.
  return 'bugfix_local'
}

const cx = (meta: AuxiliaryMeta): AuxiliaryMeta => meta
const tmsCx = (
  key: string,
  name: string,
  description: string,
  estTokens: number,
  aliases: string[] = [],
): AuxiliaryMeta => cx({
  id: `tms.${key}`,
  domain: 'project/tms',
  capability: key,
  name,
  description,
  scope: 'project-doc',
  costTier: 'low',
  granularity: 'summary',
  whenToUse: 'Use when the task needs this specific TMS.md section; prefer this over project.docs_full.',
  whenNotToUse: 'Do not use as source code or as permission to edit; verify exact code with Read before mutating files.',
  dependencies: [],
  fallbackTo: ['project.docs_full'],
  sourceResolver: `tms_${key}`,
  freshnessPolicy: 'snapshot at turn start from TMS.md',
  expectedFiles: ['TMS.md'],
  summaryAvailable: true,
  fullAvailable: true,
  estTokens,
  type: 'project-doc',
  profiles: [],
  aliases,
  phase: 1,
})

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
    profiles: [],
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
    profiles: [],
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
    profiles: [],
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
    profiles: [],
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
    profiles: [],
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
    profiles: [],
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
    profiles: [],
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
    profiles: [],
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
    profiles: [],
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
    profiles: [],
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
    profiles: [],
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
    profiles: [],
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
    expectedFiles: ['src/services/mcp/**', 'src/services/agent/toolsetSelector.ts'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 600,
    type: 'dynamic',
    profiles: [],
    aliases: ['mcp_routing_detail'],
    phase: 1,
  }),
  cx({
    id: 'agent_runtime.tool_profiles',
    domain: 'agent_runtime',
    capability: 'tool_profiles',
    name: 'Tool profiles',
    description: 'Compact dynamic-toolset profile guidance.',
    scope: 'runtime',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use when auditing or changing tool profiles, request_tools policy, or on-demand starter behavior.',
    whenNotToUse: 'Do not use for external MCP routing unless tool profile behavior is the subject.',
    dependencies: [],
    fallbackTo: ['agent_runtime.request_context_policy'],
    sourceResolver: 'tool_profiles_summary',
    freshnessPolicy: 'stable code policy',
    expectedFiles: ['src/services/agent/toolsetSelector.ts'],
    summaryAvailable: true,
    fullAvailable: false,
    estTokens: 180,
    type: 'static',
    profiles: [],
    phase: 1,
  }),
  cx({
    id: 'agent_runtime.request_context_policy',
    domain: 'agent_runtime',
    capability: 'request_context_policy',
    name: 'Request context policy',
    description: 'Policy for choosing on-demand context and avoiding broad fallbacks.',
    scope: 'runtime',
    costTier: 'low',
    granularity: 'summary',
    whenToUse: 'Use when modifying or auditing the on-demand context system itself.',
    whenNotToUse: 'Do not use for ordinary product bugfixes.',
    dependencies: [],
    fallbackTo: ['project.structure_overview'],
    sourceResolver: 'request_context_policy',
    freshnessPolicy: 'stable code policy',
    expectedFiles: ['src/services/agent/contextBuilder/auxiliaryRegistry.ts', 'src/services/agent/contextBuilder.ts'],
    summaryAvailable: true,
    fullAvailable: false,
    estTokens: 220,
    type: 'static',
    profiles: [],
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
    profiles: [],
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
    profiles: [],
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
    profiles: [],
    phase: 1,
  }),
  cx({
    id: 'delivery.deploy',
    domain: 'delivery',
    capability: 'deploy',
    name: 'Deploy/publishing',
    description: 'Publish-ready fullstack defaults and deploy/provision guidance.',
    scope: 'delivery',
    costTier: 'high',
    granularity: 'full',
    whenToUse: 'Use for deploy, publish, provision, fullstack scaffolding, or production release tasks.',
    whenNotToUse: 'Do not use for local bugfixes, semantic tokens, MCP, git-only commits, or dev-server preview troubleshooting.',
    dependencies: ['project.package_map'],
    fallbackTo: ['project.structure_overview'],
    sourceResolver: 'publishing_fullstack',
    freshnessPolicy: 'stable policy plus current package map',
    expectedFiles: ['wrangler.jsonc', 'package.json', 'src-tauri/**'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 5000,
    type: 'static',
    profiles: ['deploy_publish'],
    aliases: ['publishing_fullstack'],
    phase: 1,
  }),
  cx({
    id: 'delivery.git_status',
    domain: 'delivery/git',
    capability: 'git_status',
    name: 'Git status',
    description: 'Branch, upstream state, and changed files snapshot.',
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
    estTokens: 450,
    type: 'dynamic',
    profiles: [],
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
    profiles: [],
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
    profiles: ['scaffold_project'],
    aliases: ['scaffolding_install'],
    phase: 1,
  }),
  cx({
    id: 'auth_database.provision',
    domain: 'auth_database',
    capability: 'provision',
    name: 'Auth/database provision',
    description: 'Auth/database rules, provision workflow, and smoke-test guidance.',
    scope: 'backend',
    costTier: 'medium',
    granularity: 'summary',
    whenToUse: 'Use for auth, database, storage, upload, Firebase, SQLite, Turso, or provision tasks.',
    whenNotToUse: 'Do not use for semantic tokens, MCP, git-only, or dev-server-only tasks.',
    dependencies: ['delivery.deploy'],
    fallbackTo: ['project.package_map'],
    sourceResolver: 'auth_database_provision',
    freshnessPolicy: 'stable policy',
    expectedFiles: ['src/services/auth/**', 'src-tauri/**', 'drizzle.config.*'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 350,
    type: 'static',
    profiles: ['auth_database'],
    aliases: ['auth_database_provision'],
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
    profiles: ['vision'],
    aliases: ['vision_rules'],
    phase: 1,
  }),
  tmsCx(
    'overview',
    'TMS overview',
    'Only the Overview section from TMS.md: project purpose and related repos.',
    140,
    ['tms_overview', 'project.tms_overview'],
  ),
  tmsCx(
    'stack',
    'TMS stack',
    'Only the Stack section from TMS.md: frameworks, languages, package manager, and key dependencies.',
    180,
    ['tms_stack', 'project.tms_stack'],
  ),
  tmsCx(
    'commands',
    'TMS commands',
    'Only the Commands section from TMS.md: install, dev, test, build, worker, and release commands.',
    220,
    ['tms_commands', 'project.tms_commands'],
  ),
  tmsCx(
    'structure',
    'TMS structure',
    'Only the Structure section from TMS.md: compact directory map and ownership boundaries.',
    240,
    ['tms_structure', 'project.tms_structure'],
  ),
  tmsCx(
    'entrypoints',
    'TMS entrypoints',
    'Only the EntryPoints section from TMS.md: app, service, worker, and native entry files.',
    240,
    ['tms_entrypoints', 'project.tms_entrypoints'],
  ),
  tmsCx(
    'project_patterns',
    'TMS project patterns',
    'Only the Project Patterns section from TMS.md: local conventions and implementation patterns.',
    280,
    ['tms_project_patterns', 'project.tms_project_patterns'],
  ),
  tmsCx(
    'agent_rules',
    'TMS agent rules',
    'Only the Agent Rules section from TMS.md: repo-specific rules for agent behavior.',
    260,
    ['tms_agent_rules', 'project.tms_agent_rules'],
  ),
  tmsCx(
    'confirmed',
    'TMS confirmed facts',
    'Only the Confirmed section from TMS.md: verified project facts and recent durable decisions.',
    260,
    ['tms_confirmed', 'project.tms_confirmed'],
  ),
  tmsCx(
    'inferred',
    'TMS inferred facts',
    'Only the Inferred section from TMS.md: non-authoritative assumptions that need verification.',
    120,
    ['tms_inferred', 'project.tms_inferred'],
  ),
  tmsCx(
    'pending_confirmation',
    'TMS pending confirmation',
    'Only the Pending Confirmation section from TMS.md: open questions and facts that require user/source confirmation.',
    120,
    ['tms_pending_confirmation', 'project.tms_pending_confirmation'],
  ),
  cx({
    id: 'project.docs_full',
    domain: 'project',
    capability: 'project_docs',
    name: 'Project docs',
    description: 'Full README/TMS/PLAN/TODO bodies. Use only when docs themselves are needed.',
    scope: 'project-doc',
    costTier: 'high',
    granularity: 'full',
    whenToUse: 'Use when README/TMS/PLAN/TODO content is explicitly needed.',
    whenNotToUse: 'Do not use as general project orientation or when an index/read_file is enough.',
    dependencies: [],
    fallbackTo: ['project.structure_overview'],
    sourceResolver: 'project_docs_full',
    freshnessPolicy: 'snapshot at turn start',
    expectedFiles: ['README.md', 'TMS.md', 'PLAN.md', 'TODO.md'],
    summaryAvailable: true,
    fullAvailable: true,
    estTokens: 2000,
    type: 'project-doc',
    profiles: [],
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

  if (profile === 'scaffold_project') {
    return {
      taskDomain: 'project/scaffold',
      requiredCapabilities: ['scaffold_workflow', 'package_map'],
      minimumContextNeeded: 'summary',
      candidateContexts: ['scaffold.workflow', 'project.package_map', 'delivery.build_scripts', 'project.structure_overview'],
      selectedContexts: ['scaffold.workflow', 'project.package_map'],
      toolGroups: ['FILE_OPS', 'SHELL'],
      fallbackRisk: 'medium',
      reason: 'Scaffold profile: load workflow and package map before broader project context.',
    }
  }

  if (profile === 'deploy_publish') {
    return {
      taskDomain: 'delivery',
      requiredCapabilities: ['deploy', 'build'],
      minimumContextNeeded: 'summary',
      candidateContexts: ['delivery.deploy', 'delivery.build_scripts', 'project.package_map', 'project.structure_overview'],
      selectedContexts: ['delivery.deploy', 'delivery.build_scripts'],
      toolGroups: ['PROVISION', 'SHELL'],
      fallbackRisk: 'medium',
      reason: 'Deploy profile: deploy and build context before project structure fallback.',
    }
  }

  if (profile === 'auth_database') {
    return {
      taskDomain: 'auth_database',
      requiredCapabilities: ['provision'],
      minimumContextNeeded: 'summary',
      candidateContexts: ['auth_database.provision', 'project.package_map', 'delivery.deploy'],
      selectedContexts: ['auth_database.provision'],
      toolGroups: ['PROVISION'],
      fallbackRisk: 'medium',
      reason: 'Auth/database profile: provision context first.',
    }
  }

  if (profile === 'vision') {
    return {
      taskDomain: 'vision',
      requiredCapabilities: ['image_rules'],
      minimumContextNeeded: 'summary',
      candidateContexts: ['vision.image_rules', 'design_system.component_patterns'],
      selectedContexts: ['vision.image_rules'],
      toolGroups: ['WEB'],
      fallbackRisk: 'low',
      reason: 'Vision profile: image rules are enough unless visual implementation is also needed.',
    }
  }

  return {
    taskDomain: 'bugfix_local',
    requiredCapabilities: [],
    minimumContextNeeded: 'index',
    candidateContexts: [],
    selectedContexts: [],
    fallbackRisk: 'low',
    reason: 'Context planner unavailable; conservative fallback loads no auxiliary context.',
  }
}

export function selectAuxiliaries(
  profile: PromptProfile,
  userMessage: string | undefined,
  readOnlyHint?: boolean,
  reason?: string,
  routerInfo?: { source: 'model' | 'fallback' | 'keyword'; confidence?: 'high' | 'medium' | 'low' | 'none'; error?: string; diagnostics?: RouterDiagnostics },
  contextPlanOverride?: ContextPlan,
  plannerInfo?: { status: 'parsed' | 'fallback'; source?: 'model' | 'fallback'; modelTier?: 'utility' | 'code'; error?: string; rawOutput?: string; fallbackReason?: string; selectionReason?: string },
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
    readOnly: profile === 'analysis_readonly' ? true : readOnlyHint === true,
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

export function buildOnDemandIndex(selection: AuxiliarySelection): string | null {
  const omitted = selection.omitted
  if (omitted.length === 0) return null

  const candidateSet = new Set(selection.contextPlanCandidateSections ?? [])
  const candidates = omitted.filter(o => candidateSet.has(o.id))
  const fallbackOnly = omitted.filter(o => !candidateSet.has(o.id) && (o.granularity === 'full' || o.costTier === 'high'))
  const available = omitted.filter(o => !candidateSet.has(o.id) && !fallbackOnly.includes(o))

  const candidateLines = candidates.map((o) =>
    `- \`${o.id}\` [candidate; ${o.granularity}; ${o.costTier}] — ${o.description}`,
  )

  const byDomain = new Map<string, string[]>()
  for (const o of available) {
    const ids = byDomain.get(o.domain) ?? []
    ids.push(`\`${o.id}\``)
    byDomain.set(o.domain, ids)
  }
  const domainLines = Array.from(byDomain.entries()).map(
    ([domain, ids]) => `- ${domain}: ${ids.join(', ')}`,
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
    'Rule: request the most specific capability context first. Use broad project/full contexts only after specific/domain contexts are insufficient.',
    ...(symbolIndexLine ? [symbolIndexLine] : []),
    '',
    ...(candidateLines.length ? ['Candidate contexts:', ...candidateLines, ''] : []),
    ...(domainLines.length ? ['Other available context ids by domain:', ...domainLines, ''] : []),
    ...(fallbackLine ? [fallbackLine] : []),
  ].join('\n')
}
