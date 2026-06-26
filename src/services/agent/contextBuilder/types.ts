/**
 * Shared types for the contextBuilder slice. Section functions consume these
 * via plain parameters — no class state, no implicit `this`.
 */

import type { TemplateManifest } from '../../templateService'

export interface MCPToolSummary {
  name: string
  description: string
  serverName: string
}

export interface PackageSummary {
  name: string
  scripts: string[]
  dependencies: string[]
  devDependencies: string[]
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
 * Inputs every cmd-mode section function needs. Built once per
 * `buildCmdModeSystemPrompt` call.
 */
export interface CmdPromptContext {
  // Paths and platform
  cwd: string
  normalizedCwd: string
  homeDir: string | null
  normalizedHome: string | null
  // Memory
  globalTmsContent: string | null
  /** Project-level TMS.md content (<project>/TMS.md). Null when missing. */
  tmsContent: string | null
  claudeMdContent: string | null
  /** Session-scoped memory notes (same source as chat mode). */
  sessionMemory: string | null
  /** Pre-loaded user-scope MEMORY.md index content (cross-project facts).
   *  Null when no user memory exists yet. */
  userMemoryIndex: string | null
  /** Pre-loaded project-scope MEMORY.md index content (project-bound facts).
   *  Null when none exists yet. */
  projectMemoryIndex: string | null
  /** True iff at least one injected memory file is past the stale threshold. */
  memoryHasStale: boolean
  // Runtime config
  langInstruction: string
  mcpTools: { name: string; description: string; serverName: string }[]
}

/**
 * Inputs every chat-mode section function needs. Built once per
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
  readme: string | null
  tmsContent: string | null
  planContent: string | null
  todoContent: string | null
  templateManifest: TemplateManifest | null
  // Runtime config
  langInstruction: string
  modelProfile: import('../modelProfiles').ModelProfile | null
  mcpTools: MCPToolSummary[]
  coreToolCount: number
  /** Names of skills loaded into the prompt — surfaced to the recency
   *  reminder so the model is reminded which skill contracts apply, since
   *  the skill index itself sits mid-prompt (U-curve attention dip). */
  loadedSkillNames: string[]
  /** Already-applied scaffolding (one-shot flows like #auth-google,
   *  /payments) detected from filesystem markers. Surfaced as a system-prompt
   *  section so the agent reads existing files instead of re-scaffolding. */
  appliedScaffolding: import('../../scaffoldingDetector').ScaffoldingState
  /** Skill names triggered by hashtags in the CURRENT user message
   *  (#auth-google, #auth-email-password, #design). Used to inline CRITICAL
   *  rules at turn 1 — before scaffoldingDetector has anything to find. */
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
  expiresAt: number
}
