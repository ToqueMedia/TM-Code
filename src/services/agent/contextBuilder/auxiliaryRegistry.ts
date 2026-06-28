/**
 * Auxiliary Context Registry — on-demand context architecture for the agent
 * system prompt.
 *
 * WHY THIS EXISTS
 * ─────────────
 * The system prompt shipped ~28K tokens of *fixed* prefix on every request —
 * even a one-line bugfix that only needs read_file + edit_file. Big blocks
 * (Publishing fullstack, Scaffolding/install workflow, Vision, Auth/DB
 * provisioning) are domain-specific: they matter for scaffolding/deploy/auth
 * tasks but are dead weight on a localised bugfix. Loading them unconditionally
 * inflates input-token cost and context pressure on every turn.
 *
 * This module implements the *architecture* (not blind cuts): a registry of
 * auxiliary context blocks, a deterministic intent classifier that picks a
 * prompt profile, and a selector that decides which auxiliaries load inline
 * vs. stay available on-demand. The agent can request an omitted auxiliary
 * mid-run via the `request_context` meta-tool — the content is then injected
 * as a tool_result (the system prompt itself is fixed per run).
 *
 * WHAT LIVES WHERE
 * ────────────────
 *   - This file           → types + classifier + selection algorithm + metadata.
 *                           PURE: no import of chatSections (keeps it unit-testable
 *                           without mocking the heavy section-builder import chain).
 *   - contextBuilder.ts   → owns the LOADER implementations (calls the section
 *                           builders) + wires the selection into buildSystemPrompt.
 *   - toolsetSelector.ts  → injects the `request_context` meta-tool when
 *                           auxiliaries are omitted.
 *   - agentService.ts     → intercepts `request_context` calls (parallel to
 *                           `request_tools`) and returns the auxiliary content.
 *   - payloadInspector.ts → reports core/auxiliary token split + loaded/omitted.
 *
 * PHASING
 * ───────
 * Phase 1 (this implementation) gates the 3 highest-impact, lowest-risk groups:
 *   1. publishing_fullstack      (~5K tokens — the single biggest block)
 *   2. scaffolding_install       (~1.2K tokens — only for new-project scaffolding)
 *   3. vision_rules + auth_database_provision  (~0.5K tokens — image/auth/DB only)
 * Later phases gate UI baseline, project structure, README/TMS, MCP, skills —
 * those entries are registered here (phase: 2) so the architecture is complete,
 * but their loaders are no-ops until wired.
 */

// ── Types ───────────────────────────────────────────────────────────────

export type PromptProfile =
  | 'core'              // bare minimum (not used as a top-level default)
  | 'bugfix_local'      // localised edit in existing files — DEFAULT
  | 'analysis_readonly' // verification/audit without editing files (explicit signal)
  | 'frontend_ui'       // UI/design/visual work
  | 'scaffold_project'  // new project, install deps, setup
  | 'deploy_publish'    // deploy, publish, domain, cloud
  | 'auth_database'     // login, auth, DB, storage
  | 'vision'            // image/attachment present

export type AuxiliaryType =
  | 'static'            // static text block (publishing rules, etc.)
  | 'dynamic'           // depends on session/project state
  | 'skill'             // skill content (loaded via read_skill)
  | 'project-doc'       // README / TMS / PLAN
  | 'toolset'           // tool definitions
  | 'provider-specific' // model/provider-specific guidance

/**
 * Metadata for one auxiliary context block. The actual content loader lives in
 * contextBuilder.ts (keeps this module pure). `phase` marks which auxiliaries
 * are actively gated in the current implementation.
 */
export interface AuxiliaryMeta {
  /** Stable id used by `request_context({ auxiliary: id })`. */
  id: string
  /** Human-readable name (shown in the on-demand index). */
  name: string
  /** One-line description (shown in the on-demand index). */
  description: string
  /** Rough token cost when loaded (ceil(chars/3) of the typical body). */
  estTokens: number
  type: AuxiliaryType
  /** Profiles that auto-include this auxiliary inline. */
  profiles: PromptProfile[]
  /** Keyword triggers that auto-activate regardless of profile. */
  triggers?: RegExp[]
  /** 1 = gated now; 2 = registered for a later phase (loader is a no-op). */
  phase: 1 | 2
}

export interface AuxiliaryLoadResult {
  id: string
  name: string
  /** Why this auxiliary was loaded (profile match / trigger match). */
  reason: string
  tokens: number
}

export interface AuxiliaryOmitResult {
  id: string
  name: string
  description: string
  /** Why it was omitted (no matching profile/trigger). */
  reason: string
  estTokens: number
}

export interface AuxiliarySelection {
  profile: PromptProfile
  /** Auxiliaries loaded inline into the system prompt. */
  loaded: AuxiliaryLoadResult[]
  /** Auxiliaries available on-demand but omitted from the prompt. */
  omitted: AuxiliaryOmitResult[]
  /** Total estimated tokens of loaded auxiliaries. */
  loadedTokens: number
  /** Total estimated tokens if ALL phase-1 auxiliaries were loaded. */
  totalAvailableTokens: number
  /** Savings vs loading everything (totalAvailable - loaded). */
  savingsTokens: number
  /** Sections loaded inline automatically by profile/trigger. */
  autoLoadedSystemSections?: string[]
  /** Auxiliary ids the model requested through request_context. */
  modelRequestedContextSections?: string[]
  /** Number of request_context tool calls intercepted in this run. */
  requestContextToolCalls?: number
  /** Auxiliary ids that request_context returned with content. */
  requestContextSectionsLoaded?: string[]
  /** Auxiliary ids requested but not loaded (unknown/already inline/no content). */
  requestedButNotLoadedSections?: string[]
  /**
   * True when the user wants a read-only run (no file edits). Set by the
   * Intent Router (`readOnly` flag) — never derived from free-text phrasing.
   * `analysis_readonly` always implies readOnly=true. The ToolsetSelector
   * reads this to bound the toolset to read-only tools.
   */
  readOnly: boolean
/** Why this profile was chosen (Intent Router reason, or 'keyword classifier'
 *  when the fallback classifier was used). Surfaced in the usage log export. */
  reason: string
  /** ── Intent Router diagnostics (exported so a run proves the router ran) ── */
  /** 'model' when the LLM router classified; 'fallback' when it fell back;
   *  'keyword' when no router ran (legacy classifier only). */
  routerSource: 'model' | 'fallback' | 'keyword'
  /** Router self-reported confidence; 'none' on fallback/keyword. */
  routerConfidence: 'high' | 'medium' | 'low' | 'none'
  /** When the router failed, the failure reason (token/HTTP/timeout/…). */
  routerError?: string
  /** Full diagnostics (raw body, headers, parse error) — exported so a failed
   *  run shows exactly what the worker returned. */
  routerDiagnostics?: RouterDiagnostics
}

/** Diagnostics captured on every Intent Router HTTP call. Exported to the
 *  usage log so a failed router run is diagnosable from the session export
 *  alone (no DevTools needed). */
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

// ── Intent classifier ───────────────────────────────────────────────────

export interface IntentSignals {
  /** True when the user message carries an image/screenshot attachment. */
  hasImage?: boolean
  /** File paths the user @-mentioned (extension can hint task type). */
  mentionedFiles?: string[]
}

/**
 * Deterministic, keyword-based intent classifier. No model call — cheap and
 * reproducible. Starts from the smallest safe profile and only escalates when
 * a signal matches. Misclassifications are recoverable: the agent requests the
 * missing auxiliary via `request_context`.
 *
 * `analysis_readonly` is NOT derived here from free-text phrasing (regex/keyword
 * inference of intent is unreliable — see the `no-regex-for-inference` rule).
 * It is activated by an explicit structural signal (slash command / mode flag)
 * supplied alongside the user message; see `selectAuxiliaries`'s `readOnlyHint`.
 *
 * Order matters: vision → scaffold → deploy → auth/db → frontend → bugfix.
 * A prompt that mentions both "image" and "deploy" resolves to vision (the
 * more specific/less-common case wins).
 */
export function classifyPromptIntent(
  userMessage: string | undefined,
  signals?: IntentSignals,
): PromptProfile {
  const msg = (userMessage ?? '').toLowerCase()
  const hasImage = signals?.hasImage ?? false

  // Vision — image/screenshot/mockup present. Most specific; wins first.
  if (
    hasImage ||
    /\bimage\b|screenshot|foto|imagem|diagram|mockup|wireframe|canvas|html2canvas/i.test(msg)
  ) {
    return 'vision'
  }

  // Scaffold / new project from scratch.
  if (
    /scaffold|create.*project|new.*project|novo.*projeto|criar.*projeto|from scratch|novo.*app|create.*app|build me.*app|make.*app|gerar.*projeto/i.test(msg)
  ) {
    return 'scaffold_project'
  }

  // Deploy / publish / domain / cloud.
  if (/deploy|publish|release|\bship\b|dom[ií]nio|domain|cloud|publicar|publica[çc][ãa]o/i.test(msg)) {
    return 'deploy_publish'
  }

  // Auth / database / storage / uploads.
  if (
    /\bauth\b|login|sign.?up|sign.?in|log.?in|registo|registro|permiss[ãa]o|firebase|database|\bsql\b|sqlite|turso|libsql|\bschema\b|storage|upload|avatar|ficheiro.*upload/i.test(msg)
  ) {
    return 'auth_database'
  }

  // Frontend / UI / design. "dialog", "button", "layout", "style", "tela"…
  if (
    /\bui\b|design|component|bot[ãa]o|button|layout|style|\bcss\b|tailwind|chakra|\btema\b|\btheme\b|\bcor\b|\bcolor\b|modal|dialog|\btela\b|screen|interface visual/i.test(msg)
  ) {
    return 'frontend_ui'
  }

  // Default: smallest safe profile. A localised edit in existing files.
  return 'bugfix_local'
}

// ── Registry metadata ───────────────────────────────────────────────────

/**
 * Phase-1 auxiliaries (actively gated) + phase-2 entries (registered for
 * later, loaders are no-ops until wired). The on-demand index only lists
 * phase-1 omitted auxiliaries — phase-2 entries aren't yet extractable.
 */
export const AUXILIARY_METAS: AuxiliaryMeta[] = [
  {
    id: 'publishing_fullstack',
    name: 'Publishing (fullstack projects)',
    description: 'Publish-ready defaults: TM Code Database, Drizzle, Dockerfile, provision_database/files/deploy, brand vocabulary.',
    estTokens: 5000,
    type: 'static',
    // Loaded for scaffold/deploy/auth profiles (backend code shape + provisioning).
    profiles: ['scaffold_project', 'deploy_publish', 'auth_database'],
    triggers: [/publish|provision|fullstack|drizzle|libsql|dockerfile|turso|tmdb/i],
    phase: 1,
  },
  {
    id: 'scaffolding_install',
    name: 'Scaffolding & install workflow',
    description: 'Background install pattern + new-project scaffolding sequence (config → code → verify → dev server).',
    estTokens: 1200,
    type: 'static',
    profiles: ['scaffold_project'],
    triggers: [/scaffold|new.*project|novo.*projeto|criar.*projeto|from scratch|install.*dependenc|npm install|yarn install/],
    phase: 1,
  },
  {
    id: 'vision_rules',
    name: 'Vision (images)',
    description: 'How to treat image/screenshot descriptions inserted by the vision pipeline.',
    estTokens: 200,
    type: 'static',
    profiles: ['vision'],
    triggers: [/image|screenshot|foto|imagem|diagram|mockup|wireframe/i],
    phase: 1,
  },
  {
    id: 'auth_database_provision',
    name: 'Authentication & database rules',
    description: 'Auth hashtag triggers, auth skill reads, /api/auth/* smoke test, provision workflow.',
    estTokens: 350,
    type: 'static',
    profiles: ['auth_database', 'scaffold_project', 'deploy_publish'],
    triggers: [/\bauth\b|login|sign.?in|firebase|database|\bsql\b|sqlite|turso|libsql|provision/i],
    phase: 1,
  },
  {
    id: 'ui_baseline_full',
    name: 'UI baseline (full)',
    description: 'Full state-first UI design baseline. Load for frontend/design/visual work.',
    estTokens: 650,
    type: 'static',
    profiles: [],
    triggers: [/\b(ui|design|visual|layout|styling|polish|frontend proposal|component styling|screen design|interface visual|redesign)\b|melhorar.*\b(ui|visual|layout)\b|proposta.*frontend/i],
    phase: 1,
  },
  {
    id: 'taste_defaults',
    name: 'Taste defaults',
    description: 'Visual restraint defaults for creating or improving UI.',
    estTokens: 350,
    type: 'static',
    profiles: [],
    triggers: [/\b(visual|design|styling|polish|beautiful|redesign|landing|hero|layout|ui)\b|bonito|melhorar.*\b(ui|visual|layout)\b|criar.*ui/i],
    phase: 1,
  },
  {
    id: 'project_structure_full',
    name: 'Project structure (full)',
    description: 'Full file-tree + package summary. A compact outline stays in core.',
    estTokens: 1500,
    type: 'dynamic',
    profiles: ['scaffold_project', 'deploy_publish'],
    triggers: [/project structure|file tree|estrutura|scan.*project|map.*project|where.*file|onde.*ficheiro/i],
    phase: 1,
  },
  {
    id: 'mcp_routing_detail',
    name: 'MCP routing (detail)',
    description: 'Detailed MCP tool usage. A compact index stays in core.',
    estTokens: 600,
    type: 'dynamic',
    profiles: [],
    triggers: [/\bmcp\b|figma|canva|notion|linear|jira|github issue|google sheets|calendar/i],
    phase: 1,
  },
  {
    id: 'skills_detail',
    name: 'Skills (detail)',
    description: 'Full skill bodies. Loaded on-demand via read_skill, not inline.',
    estTokens: 2000,
    type: 'skill',
    profiles: [],
    phase: 2,
  },
  {
    id: 'project_docs_full',
    name: 'Project docs (README/TMS/PLAN)',
    description: 'Full README + TMS.md + PLAN.md content. Index stays in core.',
    estTokens: 2000,
    type: 'project-doc',
    profiles: [],
    triggers: [/readme|tms\.md|plan\.md|todo\.md|project docs|documenta[çc][ãa]o|memory|mem[oó]ria/i],
    phase: 1,
  },
  {
    id: 'dev_server_status_detail',
    name: 'Dev server status (detail)',
    description: 'Live dev-server status and preview/runtime guidance.',
    estTokens: 350,
    type: 'dynamic',
    profiles: [],
    triggers: [/dev.*server|preview|browser|runtime|vite|run|build|terminal|servidor|deploy|erro.*runtime/i],
    phase: 1,
  },
  {
    id: 'git_status_detail',
    name: 'Git status (detail)',
    description: 'Branch, upstream, and working-tree changes.',
    estTokens: 450,
    type: 'dynamic',
    profiles: [],
    triggers: [/\bgit\b|commit|branch|pull|push|diff|merge|tag|rebase|stash/i],
    phase: 1,
  },
]

// ── Selection ───────────────────────────────────────────────────────────

/**
 * Decide which phase-1 auxiliaries load inline vs. stay on-demand.
 *
 * An auxiliary loads when EITHER its profile matches the classified intent OR
 * one of its keyword triggers fires in the user message. Otherwise it's omitted
 * and listed in the on-demand index. Phase-2 entries are always "omitted" in
 * the sense that they have no loader yet — they don't appear in the index
 * (the index only lists phase-1 omitted entries the agent can actually fetch).
 */
export function selectAuxiliaries(
  profile: PromptProfile,
  userMessage: string | undefined,
  readOnlyHint?: boolean,
  reason?: string,
  routerInfo?: { source: 'model' | 'fallback'; confidence?: 'high' | 'medium' | 'low' | 'none'; error?: string; diagnostics?: RouterDiagnostics },
): AuxiliarySelection {
  const msg = userMessage ?? ''
  const phase1 = AUXILIARY_METAS.filter((m) => m.phase === 1)

  const loaded: AuxiliaryLoadResult[] = []
  const omitted: AuxiliaryOmitResult[] = []
  let loadedTokens = 0
  let totalAvailableTokens = 0

  for (const meta of phase1) {
    totalAvailableTokens += meta.estTokens
    const profileMatch = meta.profiles.includes(profile)
    const triggerMatch = meta.id === 'dev_server_status_detail' && profile === 'analysis_readonly'
      ? false
      : meta.triggers?.some((re) => re.test(msg)) ?? false

    if (profileMatch || triggerMatch) {
      const reason = profileMatch
        ? `profile "${profile}" includes this auxiliary`
        : `keyword trigger matched in user message`
      loaded.push({ id: meta.id, name: meta.name, reason, tokens: meta.estTokens })
      loadedTokens += meta.estTokens
    } else {
      omitted.push({
        id: meta.id,
        name: meta.name,
        description: meta.description,
        reason: `not included by profile "${profile}" and no trigger matched`,
        estTokens: meta.estTokens,
      })
    }
  }

  return {
    profile,
    loaded,
    omitted,
    loadedTokens,
    totalAvailableTokens,
    savingsTokens: totalAvailableTokens - loadedTokens,
    autoLoadedSystemSections: loaded.map((l) => l.id),
    modelRequestedContextSections: [],
    requestContextToolCalls: 0,
    requestContextSectionsLoaded: [],
    requestedButNotLoadedSections: [],
    // analysis_readonly is inherently read-only; otherwise honour the hint.
    readOnly: profile === 'analysis_readonly' ? true : readOnlyHint === true,
    reason: reason ?? `keyword classifier (profile=${profile})`,
    routerSource: routerInfo?.source ?? 'keyword',
    routerConfidence: routerInfo?.confidence ?? 'none',
    routerError: routerInfo?.error,
    routerDiagnostics: routerInfo?.diagnostics,
  }
}

/**
 * Build the short on-demand index injected into the core prompt when
 * auxiliaries are omitted. Lists each omitted auxiliary with its id,
 * description, and rough cost — enough for the agent to decide whether to
 * call `request_context`. Returns null when nothing is omitted (no index).
 */
export function buildOnDemandIndex(selection: AuxiliarySelection): string | null {
  const omitted = selection.omitted
  if (omitted.length === 0) return null

  const lines = omitted.map(
    (o) => `- \`${o.id}\` — ${o.description} (~${o.estTokens} tokens)`,
  )
  return [
    '# Auxiliary context (on-demand)',
    '',
    'The context blocks below were OMITTED to keep this prompt lean. If your task needs one, call `request_context({ auxiliary: "<id>" })` and the full content will be returned as a tool result for you to use this turn.',
    '',
    ...lines,
  ].join('\n')
}
