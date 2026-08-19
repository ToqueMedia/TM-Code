import { invoke } from '@/utils/invokeMetrics'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered } from '../../../stores/chatStore'
import { useAgentStore } from '../../../stores/agentStore'
import { useBillingStore } from '../../../stores/billingStore'
import AgentService from '../agentService'
import ToolExecutor from '../toolExecutor'
import CheckpointService from '../checkpointService'
import { getQueryGuard } from '../queryGuard'
import { logger } from '../../../utils/logger'
import { t } from '../../../i18n'
import { onAgentStopRequested } from '../host/hostBus'
import { appHomePath } from '../../../utils/appHomeDir'
import {
  assembleInjectedDiffs,
  buildReviewPrompt,
  buildReviewSystemPrompt,
  clipText,
  DIFF_CHAR_BUDGET,
} from './reviewDiffs'

/**
 * `/review [scope]` — adversarial code review by a fresh sub-agent.
 *
 * Why a fresh sub-agent: the main agent that authored the code is biased
 * toward justifying its own decisions. A fresh sub-agent sees the code on
 * disk with no chat history to defend, so its findings are the closest
 * thing we can get to a second pair of eyes without pulling in a real
 * reviewer.
 *
 * Scope resolution (in priority order):
 *   - `/review @path/to/file` → review that specific file
 *   - `/review last commit` → review files in `git diff HEAD~1`
 *   - `/review <free-form description>` → sub-agent decides what's in scope
 *   - `/review` (no args) → files touched in this session via checkpoints
 *
 * The IDE injects the unified diff (cli-vaz `/review` / security-review
 * pattern). The sub-agent does not modify code — `/review` is read-only.
 */

const SCOPE_LAST_COMMIT_RE = /^(last\s+commit|commit)$/i

interface ReviewScope {
  type: 'session' | 'file' | 'last_commit' | 'description' | 'empty'
  filePath?: string
  description?: string
}

interface ResolvedScope {
  scope: ReviewScope
  /** Files the sub-agent should review. Empty for 'description' (sub-agent finds them). */
  files: string[]
  /** True when we capped the original list — surface this in the prompt. */
  capped: boolean
  /** Original file count before any cap (for messaging). */
  originalCount: number
  /** Unified diff already resolved by the IDE. Empty when the sub-agent must discover files. */
  patch: string
  /** True when the patch was cut to the char budget. */
  truncated: boolean
}

export async function executeReview(
  args: string,
  projectPath: string,
): Promise<void> {
  const chatStore = useChatStore.getState()
  const agentStore = useAgentStore.getState()
  const trimmed = args.trim()

  // Pre-condition: a project must be open. Trust the dispatcher-provided
  // projectPath (resolved from currentProject?.path).
  if (!projectPath) {
    chatStore.addSystemMessage(t('review.noProject'))
    return
  }

  // Pre-condition: don't fire while the main agent is mid-turn. /review
  // dispatches its own sub-agent loop and shares the chat surface; running
  // both in parallel mixes deltas from two different agents in the same
  // assistant bubble — confusing and racy. The user should wait for the
  // current turn to finish (or hit Stop).
  const queryGuard = getQueryGuard()
  if (queryGuard.getSnapshot()) {
    chatStore.addSystemMessage(
      t('review.busy')
    )
    return
  }

  // Token budget warning. A review still reads a few files and writes a
  // long report. We warn near the cycle cap but don't block.
  const billing = useBillingStore.getState()
  if (billing.consumedPct > 0.85) {
    const pct = Math.round(billing.consumedPct * 100)
    chatStore.addSystemMessage(
      t('review.budgetWarning').replace('{pct}', String(pct))
    )
  }

  const initialScope = resolveScope(trimmed)

  // Empty scope (no args + no checkpoints) → show usage
  if (initialScope.type === 'empty') {
    chatStore.addSystemMessage(
      t('review.usage')
    )
    return
  }

  // Show the user's command in the chat IMMEDIATELY so the user sees their
  // input land before the (potentially slow) scope resolution begins.
  // Without this, getSessionDiff()/git diff/read_file validation can take
  // 1–3s and during that time the screen looks frozen.
  chatStore.addUserMessage(`/review ${trimmed || '(session)'}`)
  chatStore.startAssistantMessage()
  agentStore.setStatus('awaiting_response')
  chatStore.appendTextDelta('_Preparing review scope…_\n\n')

  // Resolve the scope to a concrete file list (or pass-through for description).
  // For session/last_commit we need filesystem/git access; for @file we
  // validate that the path actually exists so the sub-agent doesn't waste a
  // turn discovering it doesn't.
  const resolved = await resolveScopeFiles(initialScope, projectPath)
  if (resolved === null) {
    // resolveScopeFiles already surfaced a system message explaining why.
    // Clean up the placeholder assistant bubble so we don't leave an empty
    // ghost in the transcript.
    chatStore.finalizeAssistantMessage()
    agentStore.setStatus('idle')
    return
  }

  if (resolved.capped || resolved.truncated) {
    const bits: string[] = []
    if (resolved.capped) {
      bits.push(
        `scope cap: ${resolved.originalCount} files touched, reviewing the most-recent ${resolved.files.length}`,
      )
    }
    if (resolved.truncated) bits.push('diff truncated to the review budget')
    chatStore.appendTextDelta(`_(${bits.join('; ')}. Pass an explicit scope to override.)_\n\n`)
  }

  const toolExecutor = ToolExecutor.getInstance()
  // Read-only tool palette. Crucially excludes write/edit/create/delete/
  // execute_command — the sub-agent must reason about the code, not change
  // it. Includes diagnostics so it can spot type errors as evidence, and
  // dev-server logs so it can correlate code patterns with runtime issues.
  const READ_ONLY_TOOL_NAMES = new Set([
    'read_file',
    'list_directory',
    'search_files',
    'glob',
    'read_skill',
    'read_dev_server_logs',
    'read_large_result',
  ])
  const reviewerTools = toolExecutor.getToolDefinitions().filter(t =>
    READ_ONLY_TOOL_NAMES.has(t.function.name),
  )

  // Wire up an AbortController so the user's Stop button cancels the
  // sub-agent too. Without this, the main agent thinks it stopped while
  // the sub-agent keeps burning reasoning tokens in the background.
  const abortController = new AbortController()
  const stopHandler = () => abortController.abort()
  // O stop do run principal chega pelo hostBus (P1 headless): era um
  // CustomEvent no window; o emissor é agentService.cancelLoop, disparado
  // pelo botão Stop (handleStop no AgentStatusBar).
  const unsubscribeStop = onAgentStopRequested(stopHandler, { once: true })

  // No maxTurns — cli-vaz prompt commands run until the model stops.
  // query() defaults omitted maxTurns to Infinity.
  const subAgent = AgentService.createLightweight({
    tools: reviewerTools,
    readOnly: true,
    abortController,
  })
  // Sticky label on THIS instance only — not a thinking switch. The
  // worker has no sidecar for `review`; effort follows the user's selector.
  subAgent.setRequestType('review')
  subAgent.setSystemPrompt(buildReviewSystemPrompt(projectPath))

  // Shared sub-agent visibility (text/reasoning stream, tool-call
  // lifecycle, status ticks, orphan cleanup). The report is also
  // mirrored into a string so we can persist it after the run.
  const { createSubAgentVisibility } = await import('../subAgentVisibility')
  const visibility = createSubAgentVisibility({
    parentToolCallId: undefined, // /review isn't nested inside a tool call
    reasoningLabel: '/review',
    hooks: {
      // Buffered — /review sub-agent produces long-form output and goes
      // through the same 50ms coalescer used everywhere else for SSE deltas,
      // instead of one streamingVersion bump per token.
      appendTextDelta: appendTextDeltaBuffered,
      appendReasoningDelta: appendReasoningDeltaBuffered,
      addPendingToolCall: chatStore.addPendingToolCall,
      updateToolCallWithArgs: chatStore.updateToolCallWithArgs,
      updateToolCallWithResult: chatStore.updateToolCallWithResult,
      setStatus: (s) => agentStore.setStatus(s),
    },
  })

  // Buffer the assistant text for the report file. We mirror the chat
  // stream into a string so we can save the final report to disk after
  // the run, without re-fetching the message from the chat store.
  let reportBuffer = ''

  try {
    await subAgent.runAgentLoop(buildReviewPrompt(resolved), [], {
      onTextDelta: (delta) => {
        reportBuffer += delta
        visibility.callbacks.onTextDelta(delta)
      },
      onReasoningDelta: visibility.callbacks.onReasoningDelta,
      onToolCallPending: visibility.callbacks.onToolCallPending,
      onToolCallStart: visibility.callbacks.onToolCallStart,
      onToolResult: visibility.callbacks.onToolResult,
      // /review não actualiza providerState por turno — o report final é
      // montado no onDone. Turn noop para satisfazer AgentCallbacks.
      onTurnComplete: () => {},
      onDone: async () => {
        // Persist the report to disk so the user can reference it later
        // (e.g. before a PR, paste into review notes). Best-effort: any
        // failure here should not block normal completion.
        const persistedPath = await persistReport({
          projectPath,
          scope: resolved,
          report: reportBuffer,
        }).catch(err => {
          logger.warn('review', 'Persist failed', err)
          return null
        })
        if (persistedPath) {
          chatStore.appendTextDelta(
            `\n\n---\n_Report saved to \`${persistedPath}\` — open it from the editor to keep a copy._`
          )
        }
        chatStore.finalizeAssistantMessage()
        agentStore.setStatus('idle')
      },
      onError: (error) => {
        visibility.cleanupOrphans(`aborted: review failed — ${error.message}`)
        chatStore.appendTextDelta(`\n\nReview error: ${error.message}`)
        chatStore.finalizeAssistantMessage()
        agentStore.setStatus('error')
        agentStore.setError(error.message)
      },
      onUsageUpdate: (inputTokens, outputTokens) => {
        // isForeground=false: o /review corre um agente FRESCO, sem o histórico
        // do chat, por isso o prompt dele não tem relação com a ocupação da
        // conversa. Enquanto o pill guardava um máximo, isto só inflacionava;
        // desde que passou a guardar a ocupação corrente, SUBSTITUÍA — uma
        // conversa com 400K caía para ~1,5% e ficava lá (auditoria 05-08).
        chatStore.addTokenUsage(inputTokens, outputTokens, false)
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('review', 'Review sub-agent crashed', err)
    visibility.cleanupOrphans(`aborted: review crashed — ${msg}`)
    chatStore.appendTextDelta(`\n\nReview crashed: ${msg}`)
    chatStore.finalizeAssistantMessage()
    agentStore.setStatus('error')
  } finally {
    subAgent.setRequestType(null)
    unsubscribeStop()
  }
}

/**
 * Saves the assistant's final report to ~/.tmcode/reviews/{hash}/{ts}.md.
 * Returns the absolute path on success, throws on disk failure. Adds a
 * minimal frontmatter so the file is self-describing if opened weeks later
 * without context. Project hash uses the path's last segment plus a short
 * checksum-style suffix to avoid collisions across projects with the same
 * folder name (e.g. multiple "frontend" projects in different parents).
 */
async function persistReport(args: {
  projectPath: string
  scope: ResolvedScope
  report: string
}): Promise<string> {
  const { projectPath, scope, report } = args
  if (!report.trim()) {
    // Nothing to save — sub-agent never produced text (cancelled before
    // the first response, or pure-tool turn that never composed a report).
    throw new Error('Empty report')
  }

  const home = await invoke<string>('get_home_directory')
  const projectKey = projectKeyFor(projectPath)
  const dir = appHomePath(home, 'reviews', projectKey)
  await invoke('create_directories_all', { path: dir }).catch(() => {})

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const path = `${dir}/${ts}.md`
  const frontmatter = [
    '---',
    `project: ${projectPath}`,
    `scope: ${scopeLabel(scope)}`,
    `files_reviewed: ${scope.files.length}`,
    `generated: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n')

  await invoke('write_file', { path, content: frontmatter + report })
  return path
}

function projectKeyFor(projectPath: string): string {
  const lastSegment = projectPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project'
  // Cheap hash-ish suffix from the full path: sums char codes mod a large
  // prime, hex-encoded. Stable, no-deps, good enough for a small directory
  // namespace (collisions still possible but rare and harmless).
  let h = 0
  for (let i = 0; i < projectPath.length; i++) h = (h * 31 + projectPath.charCodeAt(i)) >>> 0
  return `${lastSegment}-${h.toString(16).slice(0, 6)}`
}

function scopeLabel(scope: ResolvedScope): string {
  const extra = [
    scope.capped ? `capped ${scope.files.length}/${scope.originalCount}` : '',
    scope.truncated ? 'truncated' : '',
  ].filter(Boolean).join(', ')
  switch (scope.scope.type) {
    case 'file': return `file: ${scope.scope.filePath}`
    case 'last_commit': return extra ? `last_commit (${extra})` : 'last_commit'
    case 'description': return `description: ${scope.scope.description}`
    case 'session':
    default: return extra ? `session (${extra})` : 'session'
  }
}

async function resolveScopeFiles(
  scope: ReviewScope,
  projectPath: string,
): Promise<ResolvedScope | null> {
  const chatStore = useChatStore.getState()

  switch (scope.type) {
    case 'file': {
      const filePath = scope.filePath || ''
      if (!filePath) {
        chatStore.addSystemMessage(t('review.emptyPath'))
        return null
      }
      // Validate existence before spending reasoning tokens on the spawn.
      // read_file is the cheapest existence probe we have — it errors out
      // for both missing paths and directories.
      try {
        await invoke<string>('read_file', { path: resolveAbsolute(projectPath, filePath) })
      } catch {
        chatStore.addSystemMessage(
          t('review.fileNotFound').replace('{filePath}', filePath)
        )
        return null
      }
      return { scope, files: [filePath], capped: false, originalCount: 1, patch: '', truncated: false }
    }

    case 'last_commit': {
      const resolved = await resolveLastCommitDiff(projectPath)
      if (resolved.files.length === 0 && !resolved.patch.trim()) {
        chatStore.addSystemMessage(
          'Could not determine files in the last commit. Either the project ' +
          'has no commits yet, or git is unavailable. Pass an explicit scope ' +
          '(`/review @file` or `/review <description>`) instead.'
        )
        return null
      }
      return {
        scope,
        files: resolved.files,
        capped: false,
        originalCount: resolved.files.length,
        patch: resolved.patch,
        truncated: resolved.truncated,
      }
    }

    case 'description': {
      // Sub-agent discovers its own files via Grep / Glob. We pass
      // the description through unchanged.
      return { scope, files: [], capped: false, originalCount: 0, patch: '', truncated: false }
    }

    case 'session':
    default: {
      const assembled = assembleInjectedDiffs(await collectSessionEntries(), { projectPath })
      if (assembled.files.length === 0) {
        chatStore.addSystemMessage(
          t('review.noFiles')
        )
        return null
      }
      return {
        scope,
        files: assembled.files,
        capped: assembled.capped,
        originalCount: assembled.originalCount,
        patch: assembled.patch,
        truncated: assembled.truncated,
      }
    }
  }
}

/**
 * Resolves a project-relative path to absolute. The validation read_file
 * call needs an absolute path to work with the IDE's path-clamping.
 */
function resolveAbsolute(projectPath: string, p: string): string {
  if (/^([a-zA-Z]:\\|\/)/.test(p)) return p
  // Trim accidental leading separators
  const cleaned = p.replace(/^[\\/]+/, '')
  const sep = projectPath.includes('\\') ? '\\' : '/'
  return `${projectPath.replace(/[\\/]+$/, '')}${sep}${cleaned}`
}

async function gitStdout(projectPath: string, command: string): Promise<string | null> {
  try {
    const result = await invoke<{
      stdout: string
      stderr: string
      exitCode: number
      success: boolean
    }>('execute_command', {
      command,
      cwd: projectPath,
      timeoutSecs: 15,
    })
    if (!result.success) {
      logger.warn('review', `${command} failed: ${result.stderr.slice(0, 200)}`)
      return null
    }
    return result.stdout
  } catch (err) {
    logger.warn('review', `${command} threw`, err)
    return null
  }
}

async function resolveLastCommitDiff(projectPath: string): Promise<{
  files: string[]
  patch: string
  truncated: boolean
}> {
  const [namesOut, patchOut] = await Promise.all([
    gitStdout(projectPath, 'git diff --name-only HEAD~1 HEAD'),
    gitStdout(projectPath, 'git diff HEAD~1 HEAD'),
  ])
  const files = (namesOut ?? '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  const clipped = clipText(patchOut ?? '', DIFF_CHAR_BUDGET, 'git diff HEAD~1')
  return { files, patch: clipped.text, truncated: clipped.truncated }
}

function resolveScope(trimmed: string): ReviewScope {
  if (trimmed.length === 0) {
    return { type: 'session' }
  }
  if (trimmed.startsWith('@')) {
    return { type: 'file', filePath: trimmed.slice(1).trim() }
  }
  if (SCOPE_LAST_COMMIT_RE.test(trimmed)) {
    return { type: 'last_commit' }
  }
  return { type: 'description', description: trimmed }
}

async function collectSessionEntries(): Promise<Array<{
  filePath: string
  before: string | null
  after: string | null
}>> {
  try {
    return await CheckpointService.getInstance().getSessionDiff()
  } catch (err) {
    logger.warn('review', 'getSessionDiff failed', err)
    return []
  }
}


