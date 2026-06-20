/**
 * Shared BYOK routing helpers — the single source of truth for "is this run
 * BYOK, and if so how do we talk to the provider directly?". Used by both the
 * main agent (agentService) and the Task sub-agent runner (subAgentRunner) so
 * the two paths never diverge.
 *
 * BYOK = IDE → SDK → provider DIRECT (never the TM worker). See byokTransport.ts
 * for the CORS-free transport and anthropicAdapter.ts for the Anthropic shape.
 */

import type OpenAI from 'openai'
import { invoke } from '@/utils/invokeMetrics'
import { useByokStore } from '../../stores/byokStore'
import { useChatStore } from '../../stores/chatStore'
import { createByokAgentClient } from './sdkClient'
import { resolveThinkingHint } from './thinkingShapeDetection'
import { BYOK_THINKING_BUDGET_TOKENS } from './agentConfig'
import type { ByokSessionSnapshot } from '../../types/chat'
import { logger } from '../../utils/logger'

/** The active session's frozen BYOK snapshot + whether BYOK routing is live. */
export function resolveActiveByokSnapshot(): {
  snapshot: ByokSessionSnapshot | null
  byokActive: boolean
} {
  const snapshot = useChatStore.getState().getActiveSession()?.byokSnapshot ?? null
  const byokActive = !!snapshot && useByokStore.getState().enabled
  return { snapshot, byokActive }
}

/**
 * Build the BYOK direct client for a snapshot. Reads the user's key from the OS
 * keychain just-in-time. Cloud providers without a key call `onKeyMissing` and
 * return null; local providers route without auth. Returns null on any failure
 * so callers fall back gracefully.
 */
export async function buildByokClientFromSnapshot(
  snapshot: ByokSessionSnapshot,
  opts?: { lightweight?: boolean; onKeyMissing?: () => void },
): Promise<OpenAI | null> {
  const provider = useByokStore.getState().providers.find((p) => p.id === snapshot.providerId)
  const apiShape =
    provider?.apiShape ?? (snapshot.providerId === 'anthropic' ? 'anthropic' : 'openai_compat')
  const isLocal = snapshot.local === true || provider?.local === true

  let key = ''
  try {
    key = (await invoke<string | null>('byok_get_key', { provider: snapshot.providerId })) ?? ''
  } catch (err) {
    logger.warn('byok', `keychain read failed for ${snapshot.providerId}: ${String(err)}`)
  }
  if (!key && !isLocal) {
    opts?.onKeyMissing?.()
    return null
  }

  try {
    return createByokAgentClient({
      baseURL: snapshot.baseURL,
      apiKey: key,
      apiShape,
      extraHeaders: provider?.extraHeaders,
      maxRetries: 0,
      timeout: opts?.lightweight ? 120_000 : 300_000,
    })
  } catch (err) {
    logger.warn('byok', `client build failed for ${snapshot.providerId}: ${String(err)}`)
    return null
  }
}

/**
 * Build the provider-native thinking field for a BYOK snapshot, or undefined.
 *
 * The baseURL host decides the SHAPE (resolveThinkingHint — the host that
 * actually receives the request is the ground truth). We only emit when the
 * catalog marks THIS model as a thinking model, to avoid e.g. an
 * `enable_thinking` 400 on a non-reasoning Qwen SKU. Default is thinking-ON for
 * reasoning models (the user picked one). The anthropic `thinking` object is
 * translated to the Messages API by anthropicAdapter.
 */
export function buildByokThinkingConfig(
  snapshot: ByokSessionSnapshot,
): Record<string, unknown> | undefined {
  if (snapshot.supportsThinking !== true) return undefined
  const { thinkingShape } = resolveThinkingHint({
    baseURL: snapshot.baseURL,
    catalogSupportsThinking: snapshot.supportsThinking,
    catalogShape: snapshot.thinkingShape,
  })
  switch (thinkingShape) {
    case 'anthropic':
      return { thinking: { type: 'enabled', budget_tokens: BYOK_THINKING_BUDGET_TOKENS } }
    case 'qwen_enable_thinking':
      return { enable_thinking: true }
    case 'openai_reasoning_effort':
    case 'gemini_thinking_budget':
      // Gemini's OpenAI-compat endpoint maps reasoning_effort → thinkingConfig.
      return { reasoning_effort: 'medium' }
    default:
      return undefined
  }
}
