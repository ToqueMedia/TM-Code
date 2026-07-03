/**
 * Sub-agent runner — creates a lightweight QueryEngine instance and runs
 * the agent loop in background. Publishes events to subAgentStore (NOT chatStore).
 *
 * v0.8.0 — migrated from AgentService.createLightweight + runAgentLoop to
 * QueryEngine + OpenAI SDK native streaming (claude-vaz parity).
 *
 * Features preserved:
 *   - Wall-clock timeout (definition.maxWallClockMs)
 *   - Stale detection (60s without tool call)
 *   - OS notifications on completion/timeout/error
 *   - Main agent wake on sub-agent completion
 */

import type OpenAI from 'openai'
import FirebaseAuthService from '../../auth/firebaseAuth'
import { createSubAgentClient } from '../sdkClient'
import {
  resolveActiveByokSnapshot,
  buildByokClientFromSnapshot,
  buildByokThinkingConfig,
} from '../byokRouting'
import { QueryEngine } from '../queryEngine'
import type { QueryStreamEvent, QueryTerminal, ToolExecutorFn } from '../query'
import ToolExecutor from '../toolExecutor'
import { formatError } from '../../../utils/errors'
import { useBillingStore } from '../../../stores/billingStore'
import { useSubAgentStore } from '../../../stores/subAgentStore'
import { maybeWakeMainAgent } from './autoWake'
import type { SubAgentDefinition, SubAgentParentContext } from './types'

/** Options passed to the sub-agent factory. */
export interface SubAgentRunOptions {
  definition: SubAgentDefinition
  prompt: string
  description: string
  parentMessageId: string | undefined
  parentCtx: SubAgentParentContext
  /** Tool definitions filtered to only the sub-agent's allowed tools. */
  filteredTools: import('../toolExecutor').OpenAIToolDefinition[]
  /** Worker routing header inherited from the parent run. Omitted for BYOK. */
  requestType?: string
}

function buildPartialSubAgentResult(runId: string, reason: string, partialText = ''): string {
  const run = useSubAgentStore.getState().runs.get(runId)
  const lines: string[] = [`Partial ${run?.definition.agentType ?? 'sub-agent'} result (${reason}).`]
  const trimmedText = partialText.trim()
  if (trimmedText) {
    lines.push('', trimmedText)
  }
  if (run?.toolCalls.length) {
    lines.push('', 'Observed tool calls:')
    for (const tc of run.toolCalls.slice(-12)) {
      const preview = tc.resultPreview ? `: ${tc.resultPreview}` : ''
      lines.push(`- ${tc.toolName} (${tc.status})${preview}`)
    }
  } else {
    lines.push('', 'No tool calls completed before the run stopped.')
  }
  return lines.join('\n')
}

/**
 * Run a sub-agent in background. Returns immediately.
 * The sub-agent's events flow to subAgentStore — NOT chatStore.
 */
export async function runSubAgent(options: SubAgentRunOptions): Promise<string> {
  const { definition, prompt, description, parentMessageId, parentCtx, filteredTools, requestType } = options

  // Create the run in the store — gets a runId and completionPromise.
  // Returns null if the concurrent limit (4) is reached.
  const store = useSubAgentStore.getState()
  const runResult = store.startRun(definition, prompt, description, parentMessageId)
  if (!runResult) {
    throw new Error('Maximum concurrent sub-agents reached (4). Wait for some to complete before spawning more.')
  }
  const { runId } = runResult

  // Fetch fresh state — startRun mutated the store, so the old snapshot is stale.
  const abortController = useSubAgentStore.getState().runs.get(runId)!.abortController

  // ── Auth + SDK client ──
  const authToken = await FirebaseAuthService.getInstance().getIdToken()
  if (!authToken) {
    useSubAgentStore.getState().errorRun(runId, 'Authentication expired')
    return runId
  }
  // BYOK: sub-agents are coding too — route them through the user's provider
  // direct (the conversation's frozen snapshot), never the TM worker. Falls
  // back to the managed sub-agent client when BYOK is off.
  const { snapshot: byokSnapshot, byokActive } = resolveActiveByokSnapshot()
  let client: OpenAI
  let refreshClient: () => Promise<OpenAI | null>
  let model = 'tm-active-model'
  let thinkingConfig: Record<string, unknown> | undefined
  if (byokActive && byokSnapshot) {
    const byokClient = await buildByokClientFromSnapshot(byokSnapshot, { lightweight: true })
    if (!byokClient) {
      useSubAgentStore.getState().errorRun(runId, `BYOK key missing for "${byokSnapshot.providerId}"`)
      return runId
    }
    client = byokClient
    refreshClient = async () => buildByokClientFromSnapshot(byokSnapshot, { lightweight: true })
    model = byokSnapshot.modelId
    thinkingConfig = buildByokThinkingConfig(byokSnapshot)
  } else {
    client = createSubAgentClient(authToken)
    refreshClient = async (): Promise<OpenAI | null> => {
      const auth = FirebaseAuthService.getInstance()
      const refreshed = await auth.getIdToken(true)
        ?? (await auth.refreshLogin() ? await auth.getIdToken(true) : null)
      return refreshed ? createSubAgentClient(refreshed) : null
    }
  }

  // ── Build tool definitions in OpenAI format ──
  const openaiTools: OpenAI.ChatCompletionTool[] = filteredTools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters as Record<string, unknown>,
    },
  }))

  // ── Tool executor bridge ──
  const toolExecutor = ToolExecutor.getInstance().createIsolatedChild()
  const readOnlyContextId = toolExecutor.enterReadOnlyMode()

  const executeTool: ToolExecutorFn = async (toolName, toolInput, toolUseId, signal) => {
    try {
      const raw = await toolExecutor.execute(
        toolName,
        toolInput,
        toolUseId,
        signal ?? undefined,
        definition.agentType, // memory scope for sub-agent isolation
      )
      return { content: raw, isError: false }
    } catch (err) {
      // formatError, not String(err): Tauri rejects with plain objects /
      // serde-tagged enums that otherwise render as "Error: [object Object]".
      const errorMsg = formatError(err)
      return { content: `Error: ${errorMsg}`, isError: true }
    }
  }

  // ── Build system prompt ──
  const systemPrompt = definition.getSystemPrompt(parentCtx)

  const subAgentExtraHeaders =
    !byokActive && requestType ? { 'X-Request-Type': requestType } : undefined

  // ── Create QueryEngine ──
  const engine = new QueryEngine({
    client,
    refreshClient,
    model,
    systemPrompt,
    tools: openaiTools,
    executeTool,
    thinkingConfig,
    extraHeaders: subAgentExtraHeaders,
    maxTurns: definition.maxTurns,
    onResponseHeaders: (headers) => {
      useBillingStore.getState().updateFromHeaders(headers)
    },
  })

  // ── Timers ──

  // Wall-clock timeout — fires the AbortController to kill the loop
  const wallClockTimer = setTimeout(() => {
    const run = useSubAgentStore.getState().runs.get(runId)
    if (run && run.status === 'running') {
      useSubAgentStore.getState().timeoutRun(
        runId,
        buildPartialSubAgentResult(runId, 'wall-clock timeout', resultText || run.finalText || ''),
      )
      engine.cancel()
      abortController.abort()
      import('@/services/notificationService').then(({ notify }) => {
        notify({
          title: `⏰ ${definition.agentType} task timed out`,
          body: `"${description}" exceeded the time limit`,
          evenWhenFocused: true,
          dedupKey: `subagent-timeout-${runId}`,
        })
      })
      maybeWakeMainAgent()
    }
  }, definition.maxWallClockMs)

  // Stale detection — abort if no tool call for 60s (likely stuck in model loop)
  const STALE_TIMEOUT_MS = 60_000
  let lastActivityAt = Date.now()
  const staleTimer = setInterval(() => {
    const elapsed = Date.now() - lastActivityAt
    if (elapsed > STALE_TIMEOUT_MS) {
      const run = useSubAgentStore.getState().runs.get(runId)
      if (run && run.status === 'running') {
        useSubAgentStore.getState().timeoutRun(
          runId,
          buildPartialSubAgentResult(runId, `stalled for ${Math.round(elapsed / 1000)}s`, resultText || run.finalText || ''),
        )
        engine.cancel()
        abortController.abort()
        import('@/services/notificationService').then(({ notify }) => {
          notify({
            title: `⏰ ${definition.agentType} task stalled`,
            body: `"${description}" made no tool call for ${Math.round(elapsed / 1000)}s`,
            evenWhenFocused: true,
            dedupKey: `subagent-stale-${runId}`,
          })
        })
        maybeWakeMainAgent()
      }
      clearInterval(staleTimer)
    }
  }, 10_000)

  // ── Track accumulated text + tokens ──
  let resultText = ''
  let streamErrorMessage: string | undefined
  let inputTokens = 0
  let outputTokens = 0

  // ── Fire and forget — iterate the query engine ──
  void (async () => {
    try {
      const generator = engine.submitMessage(prompt, [])

      let result = await generator.next()
      while (!result.done) {
        const event = result.value as QueryStreamEvent

        switch (event.type) {
          case 'text_delta':
            lastActivityAt = Date.now()
            resultText += event.text
            break

          case 'thinking_delta':
            lastActivityAt = Date.now()
            break

          case 'tool_use_start':
            lastActivityAt = Date.now()
            useSubAgentStore.getState().addToolCall(runId, {
              callId: event.id,
              toolName: event.name,
              argPreview: '',
              status: 'running',
            })
            break

          case 'tool_use_stop':
            break

          case 'tool_result':
            useSubAgentStore.getState().updateToolCall(runId, event.toolUseId, {
              status: event.isError ? 'errored' : 'completed',
              resultPreview: typeof event.content === 'string' ? event.content.slice(0, 80) : undefined,
            })
            break

          case 'message_stop':
            if (event.usage) {
              inputTokens += event.usage.prompt_tokens
              outputTokens += event.usage.completion_tokens
            }
            break

          case 'agent_status':
            lastActivityAt = Date.now()
            break

          case 'error':
            streamErrorMessage = event.message
            console.error(`[subAgent:${definition.agentType}] stream error:`, event.message)
            break

          case 'interrupted':
            break

          default:
            break
        }

        result = await generator.next()
      }

      // Terminal
      clearTimeout(wallClockTimer)
      clearInterval(staleTimer)

      const terminal = result.value as QueryTerminal

      if (terminal.reason === 'error') {
        const msg = streamErrorMessage || resultText || 'Model stream failed'
        console.error(`[subAgent:${definition.agentType}] terminal error:`, msg)
        useSubAgentStore.getState().errorRun(runId, msg)
        import('@/services/notificationService').then(({ notify }) => {
          notify({
            title: `❌ ${definition.agentType} task failed`,
            body: `"${description}": ${msg.slice(0, 100)}`,
            evenWhenFocused: true,
            dedupKey: `subagent-error-${runId}`,
          })
        })
        maybeWakeMainAgent()
        return
      }

      if (!resultText) {
        resultText = buildPartialSubAgentResult(runId, 'model stopped without a final summary')
      }
      useSubAgentStore.getState().finalizeRun(runId, resultText, {
        input: inputTokens,
        output: outputTokens,
      })

      import('@/services/notificationService').then(({ notify }) => {
        notify({
          title: `✅ ${definition.agentType} task completed`,
          body: `"${description}" finished successfully`,
          dedupKey: `subagent-done-${runId}`,
        })
      })
      maybeWakeMainAgent()
    } catch (err) {
      clearTimeout(wallClockTimer)
      clearInterval(staleTimer)
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[subAgent:${definition.agentType}] unhandled error:`, err)
      useSubAgentStore.getState().errorRun(runId, msg)

      import('@/services/notificationService').then(({ notify }) => {
        notify({
          title: `❌ ${definition.agentType} task failed`,
          body: `"${description}": ${msg.slice(0, 100)}`,
          evenWhenFocused: true,
          dedupKey: `subagent-error-${runId}`,
        })
      })
      maybeWakeMainAgent()
    } finally {
      clearTimeout(wallClockTimer)
      clearInterval(staleTimer)
      toolExecutor.exitReadOnlyMode(readOnlyContextId)
      toolExecutor.disposeIsolatedChild()
    }
  })()

  return runId
}
