/**
 * Sub-agent type definitions for the team-based delegation model.
 *
 * v0.7.0 — port of claude-vaz's BaseAgentDefinition, trimmed of deferred
 * fields (parallel agents, fork mode, custom agents, MCP per-agent).
 */

export type SubAgentType = 'Explore' | 'Research' | 'Verify'

export type SubAgentColor = string // hex color

export interface SubAgentDefinition {
  /** Stable identifier used as the `subagent_type` enum in the task tool. */
  agentType: SubAgentType

  /** Description the parent agent reads in the task tool schema to decide
   *  WHEN to use this sub-agent. */
  whenToUse: string

  /** Explicit tool whitelist. The executor filters at call site. */
  tools: string[]

  /** Tools blocked even if present in `tools`. Effective = tools ∖ disallowedTools. */
  disallowedTools?: string[]

  /** Hard caps. */
  maxTurns: number              // default 30
  maxWallClockMs: number        // default 5 * 60 * 1000

  /** UI border accent — hex color for the SubAgentCard left border. */
  color: SubAgentColor

  /** Skip the parent's project context (TMS.md, file tree
   *  preview, recent files) in the sub-agent's system prompt. Saves ~5-15 KB
   *  per spawn. Read-only agents that report findings to the parent don't
   *  need commit/PR/lint guidelines. */
  omitProjectContext: boolean

  /** The sub-agent's system prompt builder. Called with the resolved parent
   *  context (cmdOnlyMode, workingPath, agentLanguage). */
  getSystemPrompt: (parentCtx: SubAgentParentContext) => string
}

export interface SubAgentParentContext {
  /** False in Chat Mode (project open). True in Terminal Mode.
   *  Sub-agents inherit this — the tool executor honours cmd-mode for
   *  any file operation the sub-agent attempts. */
  cmdOnlyMode: boolean

  /** Project root in chat mode, CWD in cmd mode. */
  workingPath: string

  /** Parent's settingsStore.agentLanguage. Sub-agent responds in same lang. */
  agentLanguage: string

  /** Caller-requested search depth. Controls how much ground the sub-agent
   *  covers before returning. 'quick' = first match, 'medium' = moderate,
   *  'thorough' = comprehensive sweep. Passed through from the delegate tool. */
  thoroughness: 'quick' | 'medium' | 'thorough'
}

export interface SubAgentRun {
  id: string
  parentMessageId?: string
  definition: SubAgentDefinition
  prompt: string
  description: string               // 3-5 word label for UI
  status: 'running' | 'completed' | 'error' | 'timeout' | 'aborted'
  toolCalls: SubAgentToolCallSummary[]
  finalText: string
  errorText?: string
  startedAt: number
  endedAt?: number
  tokenUsage: { input: number; output: number }
  abortController: AbortController
  /** Promise that resolves when the sub-agent completes. Used by check_team(). */
  completionPromise: Promise<void>
  /** Internal — resolves the completionPromise. Stored so the runner can
   *  signal completion from outside the promise constructor. */
  _resolveCompletion: () => void
}

export interface SubAgentToolCallSummary {
  callId: string
  toolName: string
  /** First 80 chars of the args, sanitised. Card shows full args on expand. */
  argPreview: string
  status: 'pending' | 'running' | 'completed' | 'errored'
  resultPreview?: string
}

/** Compact summary returned by check_team(). */
export interface SubAgentRunSummary {
  id: string
  agentType: SubAgentType
  description: string
  status: SubAgentRun['status']
  duration: number          // ms
  toolCallCount: number
  finalText: string
  errorText?: string
  tokenUsage: { input: number; output: number }
}
