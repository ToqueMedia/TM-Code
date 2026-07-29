/**
 * Shared types for the contextBuilder slice. Section functions consume these
 * via plain parameters — no class state, no implicit `this`.
 */

import type { TemplateManifest } from '../../templateService'
import type { ProjectManifest } from '../../projectManifestService'

export interface MCPToolSummary {
  name: string
  description: string
  serverName: string
}

export interface PackageSummary {
  name: string
  scripts: string[]
  /** Deps da RAIZ, truncadas para o prompt. Ver `dependencyCount` para o total. */
  dependencies: string[]
  devDependencies: string[]
  /** Totais REAIS antes da truncagem — o prompt precisa deles para não mentir. */
  dependencyCount: number
  devDependencyCount: number
  /**
   * União das deps declaradas nos sub-pacotes de workspace. Num monorepo o
   * `package.json` da raiz não tem framework nenhum: sem isto, a detecção de
   * "vanilla web" dava positivo em todo o monorepo React.
   */
  workspaceDependencies: string[]
  packageManager: string
}

/** Git orientation snapshot surfaced to the agent (branch + sync + changes),
 *  so it doesn't reflexively run `git status` / `git diff` to orient. */
export interface GitContext {
  branch: string
  ahead: number
  behind: number
  files: Array<{ path: string; status: string; staged: boolean }>
  /** How many changed files were dropped past the 50-file cap (0 = none). */
  truncatedFiles: number
}

/** A recently-modified file (project-relative path + unix-seconds mtime). */
export interface RecentFileEntry {
  path: string
  modified: number
}

/** An import path alias resolved from tsconfig/jsconfig (`@/*` → `src/*`). */
export interface PathAlias {
  alias: string
  target: string
}

/**
 * Um caminho que o projecto DECLARA ser gerado — não escrito à mão.
 *
 * Existe porque um dev humano nunca precisa de deduzir isto: ao entrar num
 * projecto TypeScript sabe que os `.js` ao lado de `src/` são output do
 * compilador e nem olha para eles. O modelo não tinha esse dado e tinha de o
 * inferir do nome da pasta — o que falha nos dois sentidos: `functions/lib`
 * ERA gerado e `lib/` noutro projecto é fonte legítima. Sem o facto, a sessão
 * momenu-fact (2026-07-28) leu transpilado e propôs apagá-lo.
 *
 * A `source` é sempre uma declaração do próprio projecto (o `outDir` de um
 * tsconfig), nunca um palpite nosso sobre nomes de pastas.
 */
export interface GeneratedPath {
  /** Caminho relativo à raiz do projecto (ex.: `functions/lib`). */
  path: string
  /** Quem o declara (ex.: `functions/tsconfig.json outDir`). */
  source: string
}

/**
 * Inputs every project prompt section function needs. Built once per
 * `buildSystemPrompt` call from the parallel gather phase, then passed
 * through. Lets section functions stay pure (input → string | null), so
 * order changes and conditional inclusion are array-level concerns, not
 * nested if-pushes.
 */
export interface PromptContext {
  // Paths and project state
  projectPath: string
  normalizedProjectPath: string
  projectType: string
  tmCodeOwned: boolean
  pmDetected: string
  isVanillaWeb: boolean
  // Project content
  pkgSummary: PackageSummary | null
  treeString: string
  /** Git orientation snapshot (branch, ahead/behind, changed files). Null when
   *  the project is not a git repo. Snapshot per turn like the file tree. */
  gitContext: GitContext | null
  /** Most-recently-modified files (project-relative), newest first. Empty when
   *  none / unreadable. Points the model at the working set. */
  recentFiles: RecentFileEntry[]
  /** Import path aliases from tsconfig/jsconfig. Empty when none. */
  pathAliases: PathAlias[]
  /** Caminhos que o projecto declara serem gerados (`outDir`). Empty when none. */
  generatedPaths: GeneratedPath[]
  readme: string | null
  /** Real TMS.md body only. Null when the project has no structured TM memory. */
  tmsContent: string | null
  /**
   * Primary foreign project instructions (AGENTS.md / CLAUDE.md / .claude/CLAUDE.md)
   * when present. Always set if the file exists — even alongside TMS — so
   * project.docs_full can append dual-case content. Default system prompt
   * injects foreign full body only when tmsContent is null (see getProjectMemorySection).
   */
  foreignInstructions: import('../projectInstructions').ForeignInstructionSource | null
  planContent: string | null
  todoContent: string | null
  templateManifest: TemplateManifest | null
  projectManifest: ProjectManifest | null
  // Runtime config
  langInstruction: string
  modelProfile: import('../modelProfiles').ModelProfile | null
  mcpTools: MCPToolSummary[]
  coreToolCount: number
  /** Names of skills loaded into the prompt — surfaced to the recency
   *  reminder so the model is reminded which skill contracts apply, since
   *  the skill index itself sits mid-prompt (U-curve attention dip). */
  loadedSkillNames: string[]
  /** Skill names triggered by hashtags in the CURRENT user message
   *  (#design). Used to inline CRITICAL rules at turn 1. */
  hashtagSkills: string[]
  /** Live snapshot of the in-memory task tracker (the one `update_tasks`
   *  writes to via agentStore). Distinct from `todoContent` (which is the
   *  static TODO.md markdown — stale statuses by design): this array carries
   *  the live status of every task as the agent has marked it. Injected as a
   *  dynamic section so the agent reading "what's done / what's next" has a
   *  single deterministic source rather than inferring from the filesystem.
   *  Empty array means no tracker has been seeded (single-task work, no plan). */
  currentTasks: Array<{ id: string; description: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'; dependsOn?: string[]; blockedBy?: string[]; files?: string[] }>
  /** Pre-loaded user-scope MEMORY.md index content (`~/.toquemedia-studio/memory/`).
   *  Cross-project facts about the developer: role, preferences, validated
   *  approaches. Null when no user memory exists yet. */
  userMemoryIndex: string | null
  /** Pre-loaded project-scope MEMORY.md index content
   *  (app-managed per-project state). Project-bound facts: initiatives,
   *  references, repo conventions. Null when none exists yet. */
  projectMemoryIndex: string | null
  /** True iff at least one injected memory file is past the
   *  MEMORY_STALE_DAYS threshold. Drives the section's "verify before
   *  recommending" header so it only appears when there's a genuinely
   *  old entry, not for every project that has memories older than a month. */
  memoryHasStale: boolean
  /** Auto-extracted proposals from the previous turn — surfaced to the
   *  agent as a system reminder so it can decide whether to convert each
   *  into a real `save_memory` call. Null when there are no pending
   *  proposals (the common case). */
  pendingMemoryProposals: string | null
  /** Session-scoped memory notes maintained by the agent via
   *  `update_session_memory`. Survives context compaction but resets on
   *  new session. Null when no notes have been recorded yet. */
  sessionMemory: string | null
  /** File paths accessed during the current session. Used to filter
   *  path-scoped memory entries (entries with `paths:` frontmatter). */
  accessedFilePaths?: string[]
}

export interface PromptCacheEntry {
  key: string
  prompt: string
  /** Bloco volátil (abaixo do boundary) capturado no build — servido no hit
   *  junto com o prompt estático (a assinatura dinâmica da cacheKey garante
   *  que um hit tem volátil idêntico). */
  volatile?: string | null
  expiresAt: number
  symbolIndexTelemetry?: {
    filesConsidered: number
    filesScanned: number
    entries: number
    truncated: boolean
    tokensEstimate: number
  }
  /** Auxiliary-context ctx captured at build time, restored on cache hit so
   *  the `request_context` on-demand loader (which needs pmDetected for the
   *  scaffolding/install block) works even when the prompt itself is cached. */
  auxiliaryCtx?: {
    pmDetected: string
    isVanillaWeb: boolean
    promptCtx?: PromptContext
    loadedSkills?: import('../skillService').Skill[]
  }
}
