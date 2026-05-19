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
  claudeMdContent: string | null
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
  currentTasks: Array<{ id: string; description: string; status: 'pending' | 'in_progress' | 'completed' }>
}

export interface PromptCacheEntry {
  key: string
  prompt: string
  expiresAt: number
}
