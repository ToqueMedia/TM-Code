/**
 * Context manager — orchestrates the full context compression pipeline.
 *
 * SRP: manages context window tracking, compression triggers,
 * summarization (LLM + mechanical fallback), post-compaction recovery
 * (file re-readings, tool ops log, skills), and manual compact commands.
 *
 * DIP: depends on the compact/ and collapse/ modules (abstractions),
 * not on the agent loop or SDK directly. The agent loop injects
 * the summarization function (CompactFn) and message arrays.
 *
 * OCP: new compression strategies are added to the pipeline without
 * modifying existing steps.
 */

import { logger } from '../../utils/logger'
import { contentAsText } from './promptValueHelpers'
import { buildCompactPrompt, buildPostCompactionSummaryMessage, formatCompactSummary } from './compactPrompt'
import { archivePreCompactTranscript } from './compactTranscriptArchive'
import type { InternalMessage } from './messageUtils'
import type { SessionState } from './sessionState'
import {
  WORKER_URL,
  MIN_KEEP_RECENT_TURNS,
  MAX_KEEP_RECENT_TURNS,
  MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS,
  MICROCOMPACT_KEEP_RECENT_DENSE,
  MICROCOMPACT_GAP_THRESHOLD_MS,
  MICROCOMPACT_GAP_KEEP_RECENT,
  POST_COMPACTION_REREAD_FILES,
  POST_COMPACTION_FILE_MAX_CHARS,
  SUMMARIZE_TIMEOUT_MS,
} from './agentConfig'

// ── Types ──

export interface CompressionCallbacks {
  onCompressionStart?: (beforeTokens: number, trigger: 'auto' | 'reactive' | 'manual') => void
  onCompressionEnd?: (beforeTokens: number, trigger: 'auto' | 'reactive' | 'manual', messagesSummarized: number) => void
  onHooksStart?: (hookType: 'pre_compact' | 'post_compact') => void
}

// ── Microcompact orchestration ──

/**
 * Decide the keepRecent count for microcompaction based on:
 * - message density (dense vs normal)
 * - time since last assistant turn (gap-based eviction)
 */
export function computeMicrocompactKeepRecent(
  messages: InternalMessage[],
  lastAssistantMessageAt: number | null,
  isLightweight: boolean,
): number {
  // Density check: ≥20 tool_result blocks → dense mode
  let isDense = false
  if (messages.length >= 20) {
    let totalToolResults = 0
    for (const m of messages) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'tool_result') totalToolResults++
        }
      }
      if (totalToolResults >= 20) { isDense = true; break }
    }
  }

  let keepRecent = isDense ? MICROCOMPACT_KEEP_RECENT_DENSE : MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS

  // Time-based eviction (gap since last assistant turn > cache TTL)
  if (!isLightweight && lastAssistantMessageAt !== null) {
    const gapMs = Date.now() - lastAssistantMessageAt
    if (gapMs > MICROCOMPACT_GAP_THRESHOLD_MS) {
      keepRecent = isDense
        ? Math.max(MICROCOMPACT_GAP_KEEP_RECENT, MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS)
        : MICROCOMPACT_GAP_KEEP_RECENT
      logger.info('agent',
        `[microcompact] time-based eviction: gap=${Math.round(gapMs / 60_000)}min — keepRecent=${keepRecent} (dense=${isDense})`)
    }
  }

  return keepRecent
}

// ── LLM Summarization ──

/**
 * Call the Worker's /v1/summarize endpoint for LLM-based summarization.
 * Pure HTTP call — no store reads.
 */
export async function callSummarizationAPI(
  messages: InternalMessage[],
  authToken: string,
  appCheckHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const serialized = serializeMessagesForSummary(messages)
  const summaryPrompt = buildCompactPrompt()

  const url = `${WORKER_URL}/v1/summarize`

  // Timeout watchdog
  const timeoutCtl = new AbortController()
  const onParentAbort = () => timeoutCtl.abort()
  if (signal?.aborted) {
    timeoutCtl.abort()
  } else {
    signal?.addEventListener('abort', onParentAbort)
  }
  const timeoutId = setTimeout(() => timeoutCtl.abort(), SUMMARIZE_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        ...appCheckHeaders,
      },
      body: JSON.stringify({
        max_tokens: 16384,
        messages: [
          { role: 'system', content: summaryPrompt },
          { role: 'user', content: serialized },
        ],
      }),
      signal: timeoutCtl.signal,
    })
  } catch (err) {
    if (timeoutCtl.signal.aborted && !signal?.aborted) {
      throw new Error(`Summarization API timeout after ${SUMMARIZE_TIMEOUT_MS / 1000}s`)
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', onParentAbort)
  }

  if (!response.ok) {
    throw new Error(`Summarization API failed: ${response.status}`)
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> }
  const rawContent = data.choices[0]?.message?.content || ''
  if (rawContent.length < 100) {
    throw new Error('Summary too short or empty')
  }
  return formatCompactSummary(rawContent)
}

// ── Message serialization ──

export function serializeMessagesForSummary(messages: InternalMessage[]): string {
  const TOOL_RESULT_MAX = 4000
  const TOOL_INPUT_MAX = 800
  const TEXT_MAX = 6000
  const TOTAL_MAX = 300_000

  let totalLen = 0
  const msgStrings: string[] = []

  for (const msg of messages) {
    if (totalLen >= TOTAL_MAX) break
    const content = (msg as any).content

    let rendered: string
    if (typeof content === 'string') {
      rendered = `[${(msg as any).role.toUpperCase()}]\n${content.slice(0, TEXT_MAX)}`
    } else if (Array.isArray(content)) {
      const parts: string[] = []
      for (const block of content) {
        switch (block.type) {
          case 'text':
            parts.push(block.text.slice(0, TEXT_MAX))
            break
          case 'thinking':
            parts.push(`[THINKING]\n${(block.thinking || '').slice(0, TEXT_MAX)}`)
            break
          case 'tool_call': {
            const inputStr = JSON.stringify((block as any).arguments || (block as any).input)
            parts.push(`[TOOL CALL: ${block.name}]\n${inputStr.slice(0, TOOL_INPUT_MAX)}`)
            break
          }
          case 'tool_result': {
            const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
            parts.push(`[TOOL RESULT (${block.toolCallId})]\n${raw.slice(0, TOOL_RESULT_MAX)}`)
            break
          }
          case 'image_url':
          case 'image':
            parts.push('[image]')
            break
          default:
            parts.push(JSON.stringify(block).slice(0, TOOL_RESULT_MAX))
        }
      }
      rendered = `[${(msg as any).role.toUpperCase()}]\n${parts.join('\n')}`
    } else {
      rendered = `[${(msg as any).role.toUpperCase()}]\n${String(content || '').slice(0, TEXT_MAX)}`
    }

    totalLen += rendered.length
    msgStrings.push(rendered)
  }

  return msgStrings.join('\n\n---\n\n')
}

// ── Mechanical fallback ──

export function mechanicalFallback(messages: InternalMessage[]): string {
  const filesRead = new Set<string>()
  const filesModified = new Set<string>()
  const commandsRun: string[] = []
  const errors: string[] = []
  const userRequests: string[] = []
  const assistantNarration: string[] = []
  const toolResults: string[] = []

  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      const text = contentAsText(msg.content).slice(0, 300)
      if (!text.startsWith('[Compressed context')) userRequests.push(text)
    }
    if (msg.role === 'assistant' && msg.content) {
      assistantNarration.push(contentAsText(msg.content).slice(0, 200))
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type: string; name?: string; arguments?: string; input?: Record<string, unknown>; id?: string }>) {
        if (block.type === 'tool_call' && block.name) {
          const args = (block.arguments ? JSON.parse(block.arguments) : block.input ?? {}) as Record<string, unknown>
          const path = (args.file_path as string) || ''
          switch (block.name) {
            case 'read_file': filesRead.add(path); break
            case 'write_file': case 'create_file': case 'edit_file':
              filesModified.add(path); break
            case 'execute_command':
              commandsRun.push((args.command as string)?.slice(0, 150) || ''); break
            case 'search_files':
              toolResults.push(`Searched for "${args.query}" in ${args.directory || 'project'}`); break
            case 'start_dev_server':
              toolResults.push(`Started dev server: ${args.command || ''}`); break
          }
        }
      }
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type: string; content?: string }>) {
        if (block.type === 'tool_result' && block.content) {
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          if (text.startsWith('Error:')) errors.push(text.slice(0, 300))
          else if (text.length < 300) toolResults.push(text)
        }
      }
    }
  }

  const sections: string[] = ['(LLM summarization failed — mechanical fallback)\n']
  if (userRequests.length) sections.push(`## User Requests\n${userRequests.map((r, i) => `${i + 1}. ${r}`).join('\n')}`)
  if (assistantNarration.length) sections.push(`## Agent Actions\n${assistantNarration.map(n => `- ${n}`).join('\n')}`)
  if (filesRead.size) sections.push(`## Files Read\n${[...filesRead].join('\n')}`)
  if (filesModified.size) sections.push(`## Files Modified\n${[...filesModified].join('\n')}`)
  if (commandsRun.length) sections.push(`## Commands Run\n${commandsRun.map(c => `- ${c}`).join('\n')}`)
  if (toolResults.length) sections.push(`## Other Actions\n${toolResults.map(r => `- ${r}`).join('\n')}`)
  if (errors.length) sections.push(`## Errors\n${errors.map(e => `- ${e}`).join('\n')}`)
  return sections.join('\n\n')
}

// ── Tool ops log extraction ──

export function extractToolOpsLog(messages: InternalMessage[]): string {
  const OPS_LOG_MAX = 8000
  const ops: string[] = []

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type !== 'tool_call') continue
      const name = block.name as string
      let input: Record<string, unknown> = {}
      try { input = block.arguments ? JSON.parse(block.arguments) : {} } catch { /* ignore */ }
      let entry = ''
      switch (name) {
        case 'execute_command':
          entry = `run: ${(input.command as string)?.slice(0, 120) ?? '?'}`; break
        case 'search_files':
          entry = `search "${input.query ?? '?'}" in ${input.directory || 'project'}`; break
        case 'glob':
          entry = `glob "${input.pattern ?? '?'}"`; break
        case 'web_search':
          entry = `web search: "${input.query ?? '?'}"`; break
        case 'web_fetch':
          entry = `web fetch: ${input.url ?? '?'}`; break
        default: continue
      }
      // Find matching tool result
      for (const m of messages) {
        if (m.role !== 'user' || !Array.isArray(m.content)) continue
        for (const rb of m.content) {
          if (rb.type === 'tool_result' && rb.toolCallId === block.id) {
            const raw = typeof rb.content === 'string' ? rb.content : JSON.stringify(rb.content)
            const snippet = raw.slice(0, 200).replace(/\n/g, ' ')
            entry += ` → ${snippet}${raw.length > 200 ? '…' : ''}`
          }
        }
      }
      ops.push(`- ${entry}`)
    }
  }

  if (ops.length === 0) return ''
  let result = ops.join('\n')
  if (result.length > OPS_LOG_MAX) {
    result = result.slice(0, OPS_LOG_MAX) + '\n[... truncated]'
  }
  return result
}

// ── Context compression ──

/**
 * Compress old messages into a summary. Returns the compacted message array.
 *
 * @param messages Current message array.
 * @param state Session state (for circuit breaker).
 * @param maxTurnsToKeep Override for back-pressure retries.
 * @param authToken For summarization API calls.
 * @param appCheckHeaders For summarization API calls.
 * @param signal Abort signal.
 */
export async function compressContext(
  messages: InternalMessage[],
  state: SessionState,
  maxTurnsToKeep: number | undefined,
  authToken: string,
  appCheckHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<InternalMessage[]> {
  const systemMsg = messages[0]
  const rest = messages.slice(1)

  // Find turn boundaries
  const turnStarts: number[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].role === 'assistant') turnStarts.push(i)
  }

  const adaptiveKeep = maxTurnsToKeep ?? Math.min(
    Math.max(MIN_KEEP_RECENT_TURNS, Math.ceil(turnStarts.length * 0.3)),
    MAX_KEEP_RECENT_TURNS,
  )
  const keepFrom = turnStarts.length > adaptiveKeep
    ? turnStarts[turnStarts.length - adaptiveKeep]
    : 0

  const oldMessages = rest.slice(0, keepFrom)
  const recentMessages = rest.slice(keepFrom)

  if (oldMessages.length === 0) return messages

  // Summarize with circuit breaker
  let summary: string
  if (state.getSummarizationFailures() >= 3) {
    logger.warn('agent', `Summarization circuit breaker open — using mechanical fallback`)
    summary = mechanicalFallback(oldMessages)
  } else {
    try {
      summary = await callSummarizationAPI(oldMessages, authToken, appCheckHeaders, signal)
      if (state.getSummarizationFailures() > 0) {
        logger.info('agent', `[compaction] summarization recovered after ${state.getSummarizationFailures()} failure(s)`)
      }
      state.resetSummarizationFailures()
    } catch (err) {
      const count = state.incrementSummarizationFailures()
      const reason = err instanceof Error ? err.message : String(err)
      logger.warn('agent', `Summarization failed (${count}/3) — mechanical fallback. Reason: ${reason}`)
      summary = mechanicalFallback(oldMessages)
    }
  }

  // Archive pre-compact transcript
  let transcriptPath: string | null = null
  try {
    const [{ useChatStore }, { useProjectStore }] = await Promise.all([
      import('../../stores/chatStore'),
      import('../../stores/projectStore'),
    ])
    const sessionId = useChatStore.getState().activeSessionId
    const projectPath = useProjectStore.getState().currentProject?.path
    if (sessionId && projectPath) {
      transcriptPath = await archivePreCompactTranscript(
        projectPath, sessionId,
        oldMessages as unknown as Array<{ role: string; content: string | Array<Record<string, unknown>> | null }>,
      )
    }
  } catch { /* non-fatal */ }

  return [
    systemMsg,
    {
      role: 'user' as const,
      content: buildPostCompactionSummaryMessage(summary, {
        transcriptPath,
        recentMessagesPreserved: recentMessages.length > 0,
      }),
    },
    ...recentMessages,
  ]
}

// ── Post-compaction recovery ──

/**
 * After compaction, re-read recently accessed files and inject their content.
 * Also injects tool ops log, skills, session memory, and dev server status.
 */
export async function injectPostCompactRecovery(
  messages: InternalMessage[],
  state: SessionState,
  toolOpsLog?: string,
): Promise<void> {
  const recentFiles = state.getRecentFiles(POST_COMPACTION_REREAD_FILES)
  if (recentFiles.length === 0 && !toolOpsLog) return

  const DiffService = (await import('./diffService')).default
  const diffService = DiffService.getInstance()
  const pendingDiffs = diffService.getPendingDiffs()
  const pendingByPath = new Map(pendingDiffs.map(d => [d.filePath, d]))

  const fileContents: string[] = []
  for (const filePath of recentFiles) {
    try {
      const pending = pendingByPath.get(filePath)
      const { invoke } = await import('../../utils/invokeMetrics')
      const content = pending
        ? pending.newContent
        : await invoke<string>('read_file', { path: filePath })
      const truncated = content.length > POST_COMPACTION_FILE_MAX_CHARS
        ? content.slice(0, POST_COMPACTION_FILE_MAX_CHARS) + '\n[... truncated for context recovery]'
        : content
      const label = pending ? `${filePath} (pending approval)` : filePath
      fileContents.push(`### ${label}\n\`\`\`\n${truncated}\n\`\`\``)
    } catch { /* file may have been deleted */ }
  }

  const { devServerManager } = await import('../../services/devServerManager')
  let devServerNote = ''
  if (devServerManager.isRunning()) {
    devServerNote = `\n\nNote: A dev server is currently running at ${devServerManager.getUrl() || 'unknown URL'}. Do not start another one.`
  }

  const { buildPostCompactionSkillsBlock } = await import('./skillService')
  const skillsBlock = buildPostCompactionSkillsBlock()

  const parts: string[] = []
  if (skillsBlock) parts.push(skillsBlock)
  if (toolOpsLog) parts.push(`[Context recovery — tool operations already performed this session]\n\n${toolOpsLog}`)
  if (fileContents.length > 0) parts.push(`[Context recovery — current content of recently accessed files]\n\n${fileContents.join('\n\n')}`)
  if (devServerNote) parts.push(devServerNote)

  // Session memory recovery
  try {
    const { useChatStore } = await import('../../stores/chatStore')
    const sessionMemory = useChatStore.getState().getActiveSession()?.sessionMemory
    if (sessionMemory) parts.push(`[Session memory — recorded earlier this session]\n\n${sessionMemory}`)
  } catch { /* non-critical */ }

  if (parts.length === 0) return

  // Ensure alternation
  const lastMsg = messages[messages.length - 1]
  if (lastMsg?.role === 'user') {
    messages.push({
      role: 'assistant',
      content: '[context recovered — continuing from recovered state]',
    })
  }

  messages.push({
    role: 'user',
    content: parts.join('\n'),
  })
}

// ── Auto-save session memory ──

export function autoSaveSessionMemory(messages: InternalMessage[]): void {
  try {
    // Lazy import to avoid circular deps
    const { useChatStore } = require('../../stores/chatStore')
    const session = useChatStore.getState().getActiveSession()
    if (!session || session.sessionMemory) return

    const assistantMsgs = messages.filter(m => m.role === 'assistant').slice(-3)
    const toolNames: string[] = []
    let lastText = ''

    for (const msg of assistantMsgs) {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block.type === 'tool_call') {
          const name = (block as { name: string }).name
          const args = ((block as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>
          const arg = (args.file_path || args.command || args.pattern || args.query || '') as string
          toolNames.push(arg ? `${name}(${String(arg).slice(0, 60)})` : name)
        }
        if (block.type === 'text' && (block as { text: string }).text) {
          lastText = (block as { text: string }).text.slice(0, 200)
        }
      }
    }

    if (toolNames.length === 0 && !lastText) return

    const parts = ['[Auto-saved before compaction]']
    if (toolNames.length > 0) parts.push(`Last actions: ${toolNames.slice(-8).join(', ')}`)
    if (lastText) parts.push(`Last text: "${lastText}"`)

    useChatStore.getState().setSessionMemory(parts.join('\n'))
  } catch { /* best-effort */ }
}

// ── Estimate tokens ──

export function estimateTokenCount(messages: InternalMessage[]): number {
  let estChars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      estChars += m.content.length
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text') estChars += (b as { text: string }).text.length
        else if (b.type === 'tool_result' && typeof b.content === 'string') estChars += b.content.length
        else if (b.type === 'thinking') estChars += (b as { thinking: string }).thinking.length
        else estChars += 200
      }
    }
  }
  return Math.ceil(estChars / 4)
}

// ── Build messages from session ──

export function buildInternalMessagesFromSession(
  session: import('@/types/chat').ChatSession,
): InternalMessage[] {
  const messages: InternalMessage[] = []
  const firstMsg = session.messages[0]
  if (firstMsg?.role === 'system' && firstMsg.kind !== 'compact_boundary') {
    messages.push({ role: 'user', content: firstMsg.content })
  }
  for (const msg of session.messages) {
    if (msg.role === 'system') continue
    if (msg.kind === 'compact_boundary') continue
    messages.push({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })
  }
  return messages
}
