import { invoke } from '@/utils/invokeMetrics'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered } from '../../../stores/chatStore'
import { useAgentStore } from '../../../stores/agentStore'
import { useBillingStore } from '../../../stores/billingStore'
import AgentService from '../agentService'
import ToolExecutor from '../toolExecutor'
import CheckpointService from '../checkpointService'
import { getQueryGuard } from '../queryGuard'
import { languageDirective } from './_languageInstruction'
import { logger } from '../../../utils/logger'
import { t } from '../../../i18n'
import { GLOB_ALIAS, GREP_ALIAS, LS_ALIAS, READ_ALIAS } from '../toolNames'
import { onAgentStopRequested } from '../host/hostBus'

/**
 * Cap on how many files we ask the sub-agent to review when scope is
 * `session`. Above this, reasoning ON × N files explodes the token budget
 * with diminishing returns. The sub-agent already reads each file in full;
 * 20 is a tested sweet spot between coverage and cost.
 */
const SESSION_FILE_CAP = 20

/**
 * Auto-scaled turn limit. The sub-agent typically does:
 *   - 1 turn per file read
 *   - 2-3 turns of analysis per non-trivial file
 *   - 1-2 turns to compose the final report
 * Base 20 lets a small review (1-3 files) finish without bumping the cap;
 * the +2 per file scales for large-scope reviews; cap 60 prevents runaway
 * loops if the model gets stuck.
 */
function computeMaxTurns(fileCount: number): number {
  return Math.min(60, Math.max(20, 20 + fileCount * 2))
}

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
 * Output: structured markdown with severity tiers, top-10 by criticality,
 * each finding tied to file:line and accompanied by a one-line fix
 * direction. The sub-agent does NOT modify code — `/review` is read-only.
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

  // Token budget warning. Reasoning ON across many turns + reading several
  // files = 10–30K tokens typically. If the user is close to their cycle
  // cap, the review can push them over. We warn but don't block — the user
  // chose to run /review knowing it's reasoning-heavy.
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

  if (resolved.capped) {
    // Inline notice in the assistant bubble — the user sees what we chose.
    chatStore.appendTextDelta(
      `_(Scope cap: ${resolved.originalCount} files touched this session, ` +
      `reviewing the most-recent ${resolved.files.length}. Pass an explicit ` +
      `scope to override.)_\n\n`
    )
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

  const maxTurns = computeMaxTurns(resolved.files.length)
  const subAgent = AgentService.createLightweight({
    tools: reviewerTools,
    readOnly: true,
    maxTurns,
    abortController,
  })
  // setRequestType targets THIS sub-agent instance's private requestType,
  // not the main singleton's. Each AgentService keeps its own sticky flag,
  // so the main agent isn't affected. The 'review' value stays sticky in
  // agentService.ts:1567-1582 and is cleared in the finally block below.
  subAgent.setRequestType('review')
  subAgent.setSystemPrompt(buildReviewSystemPrompt(projectPath))

  // Use the shared sub-agent visibility helper (same one /research and
  // /verify use). It gives us the standard chat wiring — text/reasoning
  // streaming, tool-call lifecycle, status ticks, orphan cleanup — for
  // free, with the only review-specific addition layered on top below
  // (text buffer for persistence, reasoning-arrived tracker for backend-
  // mismatch detection).
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

  // Track whether reasoning ON actually arrived from the backend. If the
  // first response comes back without any reasoning deltas AND the model
  // reports thinkingMode === 'none', the proxy probably hasn't been
  // deployed with the 'review' request type — surface this once.
  let receivedAnyReasoning = false
  let warnedBackendMismatch = false
  const checkBackendMismatch = () => {
    if (warnedBackendMismatch) return
    warnedBackendMismatch = true
    const mode = useAgentStore.getState().thinkingMode
    if (!receivedAnyReasoning && mode === 'none') {
      const warning =
        '\n\n> ⚠️ _Reasoning is not active in this run — the backend may not yet ' +
        'support the `/review` request type. Findings below are from a non-thinking ' +
        'pass; rerun once the backend deploy is complete for the deeper analysis._\n\n'
      chatStore.appendTextDelta(warning)
      reportBuffer += warning
    }
  }

  try {
    await subAgent.runAgentLoop(buildReviewPrompt(resolved), [], {
      onTextDelta: (delta) => {
        reportBuffer += delta
        visibility.callbacks.onTextDelta(delta)
      },
      onReasoningDelta: (delta) => {
        receivedAnyReasoning = true
        visibility.callbacks.onReasoningDelta(delta)
      },
      onToolCallPending: visibility.callbacks.onToolCallPending,
      onToolCallStart: visibility.callbacks.onToolCallStart,
      onToolResult: visibility.callbacks.onToolResult,
      onTurnComplete: () => {
        checkBackendMismatch()
      },
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
 * Saves the assistant's final report to ~/.toquemedia-studio/reviews/{hash}/{ts}.md.
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
  const dir = `${home}/.toquemedia-studio/reviews/${projectKey}`
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
  switch (scope.scope.type) {
    case 'file': return `file: ${scope.scope.filePath}`
    case 'last_commit': return 'last_commit'
    case 'description': return `description: ${scope.scope.description}`
    case 'session':
    default: return scope.capped
      ? `session (capped ${scope.files.length}/${scope.originalCount})`
      : 'session'
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
      return { scope, files: [filePath], capped: false, originalCount: 1 }
    }

    case 'last_commit': {
      const files = await resolveLastCommitFiles(projectPath)
      if (files.length === 0) {
        chatStore.addSystemMessage(
          'Could not determine files in the last commit. Either the project ' +
          'has no commits yet, or git is unavailable. Pass an explicit scope ' +
          '(`/review @file` or `/review <description>`) instead.'
        )
        return null
      }
      return { scope, files, capped: false, originalCount: files.length }
    }

    case 'description': {
      // Sub-agent discovers its own files via Grep / Glob. We pass
      // the description through unchanged.
      return { scope, files: [], capped: false, originalCount: 0 }
    }

    case 'session':
    default: {
      const all = await collectSessionFiles()
      if (all.length === 0) {
        chatStore.addSystemMessage(
          t('review.noFiles')
        )
        return null
      }
      // Cap the list when it grows large. Reverse first so we pick the most
      // recently-touched (assuming insertion order ≈ touch order from the
      // checkpoint baseline).
      const reversed = [...all].reverse()
      const files = reversed.slice(0, SESSION_FILE_CAP)
      return {
        scope,
        files,
        capped: all.length > SESSION_FILE_CAP,
        originalCount: all.length,
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

async function resolveLastCommitFiles(projectPath: string): Promise<string[]> {
  try {
    const result = await invoke<{
      stdout: string
      stderr: string
      exitCode: number
      success: boolean
    }>('execute_command', {
      command: 'git diff --name-only HEAD~1 HEAD',
      cwd: projectPath,
      timeoutSecs: 10,
    })
    if (!result.success) {
      logger.warn('review', `git diff failed: ${result.stderr.slice(0, 200)}`)
      return []
    }
    return result.stdout
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  } catch (err) {
    logger.warn('review', 'last-commit resolution threw', err)
    return []
  }
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

async function collectSessionFiles(): Promise<string[]> {
  try {
    const diff = await CheckpointService.getInstance().getSessionDiff()
    // Dedup + filter out files where after === null (deleted; reviewing
    // deleted code makes no sense) and where before === after (no real
    // change despite a checkpoint, e.g. revert-then-redo).
    const files = new Set<string>()
    for (const entry of diff) {
      if (entry.after === null) continue
      if (entry.before === entry.after) continue
      files.add(entry.filePath)
    }
    return Array.from(files)
  } catch (err) {
    logger.warn('review', 'getSessionDiff failed', err)
    return []
  }
}

function buildReviewSystemPrompt(projectPath: string): string {
  return `<role>
You are a senior code reviewer running as a FRESH sub-agent inside TM Code. You have no chat history with the user — only the code on disk and the review request below. This isolation is intentional: it protects you from defending decisions made earlier in the session that you would otherwise be biased to justify.

Your job is to find real defects and meaningful issues, not to validate cosmetic preferences. Surprising code that works as designed is not a bug. A pattern that looks unfamiliar to you is not necessarily wrong — verify against the actual usage in the project before reporting.
</role>

<language>${languageDirective()}</language>

<project_path>${projectPath}</project_path>

<severity_tiers>
Use these EXACT four tiers. Do not invent intermediate ones.

CRITICAL — bugs, security holes, data loss risks, race conditions, broken invariants. The code is wrong, not just imperfect. Examples: missing await on async ops with side effects, unhandled rejection that takes down a process, SQL injection, secrets logged to disk, mutations that violate ownership.

HIGH — anti-patterns the language/framework community considers wrong AND that will bite under realistic conditions. Examples: useEffect with missing dependency that captures stale state, unbounded retry loop, blocking I/O on the request thread, ignored Promise return value where the result matters.

MEDIUM — fragile workarounds / bad separation of concerns. The code works today but is hard to maintain or extend. Examples: type assertions hiding a real type mismatch, magic numbers without constants, business logic in a UI component, copy-pasted code that should be a function.

LOW — naming, organization, micro-readability. Defaults: do NOT report unless you have already filled the higher tiers and have token budget left. Examples: variable name unclear in context, function too long for its single concern, comments that restate the code.
</severity_tiers>

<protocol>
1. Read the review request and identify the scope (specific file, last commit, session changes, or free-form description).

2. Read the relevant files completely. Do not skim. If the request mentions a flow that spans multiple files, follow the references with ${READ_ALIAS} / ${GREP_ALIAS} / ${GLOB_ALIAS}.

3. If the project has a TMS.md (project memory), read it. It often documents intentional architectural choices that look unusual but are deliberate.

4. For each candidate finding, BEFORE writing it down:
   - Verify against the source: does the code actually behave the way you fear? Read it again. Check the call sites.
   - Ask yourself: am I flagging this because it is wrong, or because I would have written it differently? Discard the second category.
   - Map it to ONE of the four severity tiers above. If unsure between two tiers, pick the lower one.

5. Cap output: report at most TEN findings, ordered by severity (critical → high → medium → low). If you found more, summarize the rest in a final paragraph ("plus N additional MEDIUM/LOW issues — happy to detail on request").

6. Format each finding as:

   ### [SEVERITY] One-line summary
   **Location:** \`relative/path/to/file.ext:LINE\`
   **Why it matters:** one sentence on the concrete impact.
   **Recommendation:** one-line fix direction (where to look, not full code).

7. End with a one-line summary: \`Found: <N> findings (<C> critical, <H> high, <M> medium, <L> low). Reviewed: <X> files.\`
</protocol>

<constraints>
- READ-ONLY. Do not call write_file, edit_file, create_file, delete_file, rename_file, or execute_command. They are not in your tool palette anyway, but do not try.
- Do not propose code blocks longer than 5 lines. Recommendations are directional, not implementations.
- Do not flag stylistic preferences unless they cross into MEDIUM (clear maintainability cost).
- Do not flag missing tests unless the file under review IS a test, or the user explicitly asked.
- Do not flag missing documentation unless code intent is genuinely unclear from reading.
- If you would have nothing in CRITICAL or HIGH, say so explicitly. Do not pad with LOW just to fill the report.
- Reasoning is forced ON for this turn. Use it: weigh each finding's severity carefully, verify against source.
</constraints>

<output>
Brief preamble (1 line) stating what you reviewed.
Findings, in severity order, max 10, formatted as in protocol step 6.
Final summary line.
</output>`
}

function buildReviewPrompt(resolved: ResolvedScope): string {
  const { scope, files, capped, originalCount } = resolved
  const fileList = files.map(f => `  - ${f}`).join('\n')

  switch (scope.type) {
    case 'file':
      return `Review the file: \`${files[0]}\`\n\nRead it in full, follow references as needed using ${READ_ALIAS}/${GREP_ALIAS}, and report findings per the protocol.`

    case 'last_commit':
      return `Review the files changed in the last git commit (HEAD~1..HEAD). The IDE already resolved the file list:\n\n${fileList}\n\nRead each in full and report findings per the protocol. Pay special attention to the diff between HEAD~1 and HEAD where you can — those are the lines that just landed.`

    case 'description':
      return `Review the feature/area described: "${scope.description}"\n\nFind the relevant files yourself using ${GREP_ALIAS} / ${GLOB_ALIAS} / ${LS_ALIAS}, then review per the protocol. Don't review unrelated files.`

    case 'session':
    default: {
      const capNote = capped
        ? `\n\nNote: ${originalCount} files were touched this session; the IDE capped the list above to the most-recent ${files.length} to keep the review focused. If you finish with budget left, you can ask the user whether to extend.`
        : ''
      return `Review the files modified in the current session:\n\n${fileList}${capNote}\n\nRead each in full and report findings per the protocol. These were just changed, so focus on the changes themselves where you can infer them; treat the rest of each file as context for evaluating those changes.`
    }
  }
}
