/**
 * Sub-agent runner — creates a lightweight AgentService instance and runs
 * the agent loop in background. Publishes events to subAgentStore (NOT chatStore).
 *
 * v0.7.0 — replaces the inline fire-and-forget pattern in spawn_background_agent.
 */

import { useSubAgentStore } from '../../../stores/subAgentStore'
import { maybeWakeMainAgent } from './autoWake'
import type { SubAgentDefinition, SubAgentParentContext } from './types'
import type { AgentCallbacks } from '../agentService'
import type { OpenAIToolDefinition } from '../toolExecutor'

/** Options passed to the sub-agent factory. */
export interface SubAgentRunOptions {
  definition: SubAgentDefinition
  prompt: string
  description: string
  parentMessageId: string | undefined
  parentCtx: SubAgentParentContext
  /** Tool definitions filtered to only the sub-agent's allowed tools. */
  filteredTools: OpenAIToolDefinition[]
}

/**
 * Run a sub-agent in background. Returns immediately.
 * The sub-agent's events flow to subAgentStore — NOT chatStore.
 */
export async function runSubAgent(options: SubAgentRunOptions): Promise<string> {
  const { definition, prompt, description, parentMessageId, parentCtx, filteredTools } = options

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

  // Dynamically import to avoid circular deps
  const agentModule = await import('../agentService')
  const AgentService = agentModule.default

  // Create a fresh AgentService instance (not the singleton)
  // readOnly=true ensures no diff approval prompts from sub-agents.
  const subAgent = AgentService.createLightweight({
    tools: filteredTools,
    readOnly: true,
    abortController,
  })

  // Build the sub-agent's system prompt
  const systemPrompt = definition.getSystemPrompt(parentCtx)
  subAgent.setSystemPrompt(systemPrompt)

  // Wall-clock timeout — fires the AbortController to kill the loop
  const wallClockTimer = setTimeout(() => {
    const run = useSubAgentStore.getState().runs.get(runId)
    if (run && run.status === 'running') {
      useSubAgentStore.getState().timeoutRun(runId, run.finalText || '')
      run.abortController.abort()
      maybeWakeMainAgent()
    }
  }, definition.maxWallClockMs)

  // Track accumulated text + tokens
  let resultText = ''
  let inputTokens = 0
  let outputTokens = 0

  // Fire and forget — the main agent continues immediately
  subAgent.runAgentLoop(prompt, [], {
    onTextDelta: (delta) => {
      resultText += delta
    },
    onReasoningDelta: () => {
      // Sub-agent reasoning is NOT surfaced to the parent or user.
      // It lives in the sub-agent's context only.
    },
    onToolCallPending: (childId, toolName) => {
      useSubAgentStore.getState().addToolCall(runId, {
        callId: childId,
        toolName,
        argPreview: '',
        status: 'running',
      })
    },
    onToolCallStart: (childId, _toolName, args) => {
      // Update arg preview
      const preview = JSON.stringify(args).slice(0, 80)
      useSubAgentStore.getState().updateToolCall(runId, childId, { argPreview: preview })
    },
    onToolResult: (childId, _toolName, result, isError) => {
      useSubAgentStore.getState().updateToolCall(runId, childId, {
        status: isError ? 'errored' : 'completed',
        resultPreview: typeof result === 'string' ? result.slice(0, 80) : undefined,
      })
    },
    onTurnComplete: () => {},
    onDone: (finalText) => {
      clearTimeout(wallClockTimer)
      if (finalText && !resultText) resultText = finalText
      useSubAgentStore.getState().finalizeRun(runId, resultText || 'No results found.', {
        input: inputTokens,
        output: outputTokens,
      })
      // Wake the main agent to collect this result
      maybeWakeMainAgent()
    },
    onError: (error) => {
      clearTimeout(wallClockTimer)
      useSubAgentStore.getState().errorRun(runId, error.message)
      maybeWakeMainAgent()
    },
    onUsageUpdate: (inp, out) => {
      inputTokens += inp
      outputTokens += out
    },
  } satisfies AgentCallbacks).catch((err) => {
    clearTimeout(wallClockTimer)
    const msg = err instanceof Error ? err.message : String(err)
    useSubAgentStore.getState().errorRun(runId, msg)
    maybeWakeMainAgent()
  })

  return runId
}
