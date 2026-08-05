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
import { useBillingStore } from '../../stores/billingStore'
import { createByokAgentClient } from './sdkClient'
import { extractAssistantTextFromCompletion } from './completionText'
import { resolveThinkingHint } from './thinkingShapeDetection'
import { BYOK_THINKING_BUDGET_TOKENS } from './agentConfig'
import type { ByokSessionSnapshot } from '../../types/chat'
import { logger } from '../../utils/logger'
import { isFreePlan } from './byokPlans'

// Re-export so existing importers (and tests) can keep getting it from here.
export { isFreePlan }

const ANTHROPIC_ADAPTIVE_THINKING_MODELS = [
  /^claude-fable-5(?:-|$)/,
  /^claude-mythos-5(?:-|$)/,
  /^claude-mythos-preview(?:-|$)/,
  // Família 5 completa (auditoria BYOK 05-08): claude-opus-5/claude-sonnet-5
  // faltavam — caíam no fallback budget_tokens, que esses modelos REJEITAM
  // com 400 em todos os pedidos (o user via o erro cru do provider).
  /^claude-opus-5(?:-|$)/,
  /^claude-sonnet-5(?:-|$)/,
  /^claude-opus-4-(?:6|7|8)(?:-|$)/,
  /^claude-sonnet-4-6(?:-|$)/,
]

type ByokReasoningEffort = NonNullable<ByokSessionSnapshot['reasoningEffort']>

function defaultReasoningEffort(snapshot: ByokSessionSnapshot): ByokReasoningEffort {
  if (snapshot.reasoningEffort) return snapshot.reasoningEffort
  return 'medium'
}

function openAICompatibleReasoningEffort(effort: ByokReasoningEffort): 'low' | 'medium' | 'high' {
  if (effort === 'xhigh' || effort === 'max') return 'high'
  return effort
}

function anthropicThinkingConfig(snapshot: ByokSessionSnapshot): Record<string, unknown> {
  const effort = defaultReasoningEffort(snapshot)
  const usesAdaptiveThinking = ANTHROPIC_ADAPTIVE_THINKING_MODELS.some((pattern) =>
    pattern.test(snapshot.modelId),
  )
  if (usesAdaptiveThinking) {
    return {
      thinking: { type: 'adaptive' },
      output_config: { effort },
    }
  }
  return { thinking: { type: 'enabled', budget_tokens: BYOK_THINKING_BUDGET_TOKENS } }
}

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
 * Snapshot BYOK para um run cuja SESSÃO é conhecida (tarefa paralela /
 * sub-agent com dono): usa o snapshot CONGELADO dessa sessão — nunca o da
 * sessão visível, que o user pode ter trocado entre o lançamento e o arranque
 * do runner (herança BYOK, doutrina "sem deus" 2026-07-17). Sessão em falta
 * (edge: tarefa sem transcript) → comportamento antigo (sessão ativa).
 */
export function resolveByokSnapshotForSession(sessionId?: string | null): {
  snapshot: ByokSessionSnapshot | null
  byokActive: boolean
} {
  const chat = useChatStore.getState()
  const session = (sessionId ? chat.sessions.get(sessionId) : undefined) ?? chat.getActiveSession()
  const snapshot = session?.byokSnapshot ?? null
  const byokActive = !!snapshot && useByokStore.getState().enabled
  return { snapshot, byokActive }
}

/**
 * Should an AUXILIARY model call (memory, commit message, etc.) route through
 * the user's BYOK key? True only on free plans with BYOK active. Returns the
 * snapshot to use, or null to keep the managed (worker) path.
 *
 * Paid + BYOK → null (auxiliaries use TM infra). Non-BYOK → null.
 */
export function resolveAuxByokRoute(): { snapshot: ByokSessionSnapshot } | null {
  const { snapshot, byokActive } = resolveActiveByokSnapshot()
  if (!byokActive || !snapshot) return null
  if (!isFreePlan(useBillingStore.getState().plan)) return null
  return { snapshot }
}

/**
 * Run a one-shot (non-streaming) auxiliary completion through the user's BYOK
 * provider. Returns the assistant message text, or null on any failure (callers
 * fall back to their managed/empty path). Anthropic has no `response_format`, so
 * jsonObject is dropped there — the caller's tolerant JSON parser handles it.
 */
export async function byokAuxCompletion(
  snapshot: ByokSessionSnapshot,
  params: {
    messages: Array<{ role: string; content: string }>
    maxTokens: number
    temperature?: number
    jsonObject?: boolean
    signal?: AbortSignal
  },
): Promise<string | null> {
  const client = await buildByokClientFromSnapshot(snapshot, { lightweight: true })
  if (!client) return null
  const provider = useByokStore.getState().providers.find((p) => p.id === snapshot.providerId)
  const isAnthropic =
    (provider?.apiShape ?? (snapshot.providerId === 'anthropic' ? 'anthropic' : 'openai_compat')) ===
    'anthropic'
  const body: Record<string, unknown> = {
    model: snapshot.modelId,
    max_tokens: params.maxTokens,
    messages: params.messages,
    stream: false,
  }
  // Anthropic: `temperature` foi REMOVIDA na família 5 / Opus 4.7+ — enviá-la
  // é 400 em todos os pedidos, e com o catch de baixo isso significava
  // memórias/commit-messages mortos EM SILÊNCIO (auditoria BYOK 05-08). Os
  // auxiliares toleram o default de temperatura; omitir é o custo mais baixo.
  if (params.temperature != null && !isAnthropic) body.temperature = params.temperature
  if (params.jsonObject && !isAnthropic) body.response_format = { type: 'json_object' }
  try {
    const resp = await client.chat.completions.create(
      body as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
      params.signal ? { signal: params.signal } : undefined,
    )
    return extractAssistantTextFromCompletion(resp) || null
  } catch (err) {
    // O fallback (caminho gerido/vazio) continua a ser a resposta certa, mas
    // a falha tem de deixar rasto — sem isto um 400 sistemático do provider
    // era indistinguível de "não havia nada a extrair".
    logger.warn(
      'byok',
      `aux completion failed (${snapshot.providerId}/${snapshot.modelId}): ${String(err).slice(0, 200)}`,
    )
    return null
  }
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
    const client = createByokAgentClient({
      baseURL: snapshot.baseURL,
      apiKey: key,
      apiShape,
      extraHeaders: provider?.extraHeaders,
      maxRetries: 0,
      timeout: opts?.lightweight ? 120_000 : 300_000,
    })
    // Runtime evidence: the agent will talk to the user's provider directly,
    // billed to their key — the TM worker (the only metering point) is bypassed.
    let host = snapshot.baseURL
    try {
      host = new URL(snapshot.baseURL).host
    } catch {
      /* keep raw */
    }
    logger.info(
      'byok',
      `direct client → ${snapshot.providerId}/${snapshot.modelId} @ ${host} (TM worker bypassed; key=${key ? 'user' : 'local-none'})`,
    )
    return client
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
      return anthropicThinkingConfig(snapshot)
    case 'qwen_enable_thinking':
      return { enable_thinking: true }
    case 'openai_reasoning_effort':
    case 'gemini_thinking_budget':
      // Gemini's OpenAI-compat endpoint maps reasoning_effort → thinkingConfig.
      return { reasoning_effort: openAICompatibleReasoningEffort(defaultReasoningEffort(snapshot)) }
    case 'openrouter_reasoning':
      // OpenRouter normaliza `reasoning.effort` para o formato do modelo por
      // trás (o-series → reasoning_effort, Anthropic → budget). Antes caía no
      // default e o effort do user era silenciosamente ignorado.
      return { reasoning: { effort: openAICompatibleReasoningEffort(defaultReasoningEffort(snapshot)) } }
    case 'mimo_chat_template_kwargs':
    case 'moonshot_thinking':
      // Deliberadamente SEM emissão no estado ON:
      //  - MiMo: doutrina Xiaomi — thinking degrada tool_calls; o default do
      //    provider (off) é o comportamento correcto para o agente.
      //  - Moonshot: só K2.5/K2.6 honram o toggle; os SKUs *-thinking
      //    raciocinam incondicionalmente e um campo extra arrisca 400.
      // (Os shapes ficam na tabela de detecção para documentar o param de
      // disable de cada família — hoje não há toggle OFF no BYOK.)
      return undefined
    default:
      return undefined
  }
}
