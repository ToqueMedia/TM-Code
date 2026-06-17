/**
 * Model profiles — per-model configuration for TM Code agent.
 *
 * Supported models: GLM 5.2, Qwen 3.7 Max, MiMo V2.5 Pro 1M, MiMo V2.5 1M.
 *
 * The dedicated AI pass-through Worker handles auth and provider API key
 * injection. The Control Plane owns the active provider/model choice.
 */

import type { UserPlanName } from '../../stores/billingStore'

// ── Types ──

export interface ModelPersona {
  /** Persona name shown to user (not the model name) */
  name: string
  /** Short tagline describing the persona's strength */
  tagline: string
}

export interface Counterweight {
  rule: string
  addedFor: string
  addedOn: string
  reviewAfter: string
}

export type ThinkingMode = 'toggleable' | 'mandatory' | 'none'

export interface ModelProfile {
  id: string
  name: string
  persona: ModelPersona
  modelId: string
  contextWindow: number
  maxOutputTokens: number

  // ── Sampling ──
  temperature: number
  reasoningTemperature: number | null
  topP: number
  topPNonThinking?: number | null
  topK: number | null
  extraSamplingParams?: Record<string, unknown>

  // ── Thinking / Reasoning ──
  thinkingMode: ThinkingMode
  supportsThinking: boolean
  thinkingParam: 'enable_thinking' | 'thinking' | 'reasoning' | null
  thinkingBudget: number | null
  thinkingMandatory: boolean

  // ── Features ──
  preserveReasoning: boolean
  supportsAttachments: boolean
  supportsSearch: boolean
  counterweights: Counterweight[]
}

// ── Helpers ──

export function renderCounterweights(profile: ModelProfile): string {
  if (!profile.counterweights || profile.counterweights.length === 0) return ''
  return profile.counterweights.map(c => `- ${c.rule}`).join('\n')
}

// ─────────────────────────────────────────────────
// GLM-5.2 — Zhipu, servido por DOIS provedores OpenAI-compatíveis
//
// O data-plane (worker ai-pass-through) roteia para z.AI oficial OU para
// DashScope/Alibaba Cloud (US) consoante a config ativa em KV — ambos
// expõem o mesmo glm-5.2. 1M de contexto, até 128K de saída.
//
// Thinking é ON por defeito no modelo. A forma do parâmetro DIFERE por
// provedor (z.AI: `thinking: { type: 'enabled'|'disabled' }`; DashScope:
// `enable_thinking` boolean) — mas a IDE NÃO o envia: buildThinkingConfig()
// devolve undefined e o worker injeta a forma correta via config.extraBody.
// thinkingParam ('thinking') fica registado como a forma canónica do modelo.
//
// contextWindow/maxOutputTokens aqui são apenas o fallback de display; o
// número real chega em X-Model-Context-Window emitido pelo worker.
// ─────────────────────────────────────────────────

const GLM_5_2: ModelProfile = {
  id: 'glm-5.2',
  name: 'GLM-5.2',
  persona: {
    name: 'GLM',
    tagline: 'Agentes de longo curso — 1M de contexto via z.AI / DashScope',
  },
  modelId: 'glm-5.2',
  contextWindow: 1_000_000,
  maxOutputTokens: 131_072,

  // GLM-5.2 default sampling — não ajustar temperature e top_p em simultâneo.
  temperature: 1.0,
  reasoningTemperature: null,
  topP: 0.95,
  topK: null,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'thinking',
  thinkingBudget: null,
  thinkingMandatory: false,

  preserveReasoning: false,
  supportsAttachments: false,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// Qwen 3.7 Max (snapshot 2026-06-08) — Alibaba China (DashScope)
//
// Alibaba Cloud flagship. 1M context window, toggleable thinking.
// Sampling: temp 0.6, top_p 0.95, top_k 20.
//
// Snapshot 2026-06-08 substitui o qwen3.7-max base (2026-06-11): traz
// Visual Understanding e web search NATIVOS — supportsAttachments e
// supportsSearch ligados significam que o modelo dispensa os sidecars
// correspondentes (a pesquisa é executada pelo provider, não localmente;
// imagens vão como image_url no payload).
// ─────────────────────────────────────────────────

const QWEN_3_7_MAX: ModelProfile = {
  id: 'qwen3.7-max-2026-06-08',
  name: 'Qwen 3.7 Max',
  persona: {
    name: 'Qwen Max',
    tagline: 'Flagship Alibaba Cloud — 1M contexto, visão e pesquisa nativas',
  },
  modelId: 'qwen3.7-max-2026-06-08',
  contextWindow: 1_000_000,
  maxOutputTokens: 65_536,

  temperature: 0.6,
  reasoningTemperature: null,
  topP: 0.95,
  topK: 20,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'enable_thinking',
  thinkingBudget: null,
  thinkingMandatory: false,

  preserveReasoning: false,
  supportsAttachments: true,
  supportsSearch: true,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// MiMo V2.5 Pro 1M — Xiaomi (Anthropic-compatible)
//
// Xiaomi's flagship reasoning model. 1M context window.
// Toggleable thinking via enable_thinking boolean.
// ─────────────────────────────────────────────────

const MIMO_V2_5_PRO_1M: ModelProfile = {
  id: 'mimo-v2.5-pro-1m',
  name: 'MiMo V2.5 Pro 1M',
  persona: {
    name: 'Mimo Pro',
    tagline: 'Raciocínio avançado com custo otimizado — modelo padrão do TM Code. Custo: 2x',
  },
  modelId: 'mimo-v2.5-pro',
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,

  temperature: 0.3,
  reasoningTemperature: null,
  topP: 0.95,
  topK: null,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'enable_thinking',
  thinkingBudget: 8192,
  thinkingMandatory: false,

  preserveReasoning: true,
  supportsAttachments: false,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// MiMo V2.5 1M — Xiaomi (Anthropic-compatible)
//
// Smaller MiMo sibling. 1M context window. Same thinking
// shape as V2.5 Pro (enable_thinking boolean).
// ─────────────────────────────────────────────────

const MIMO_V2_5_1M: ModelProfile = {
  id: 'mimo-v2.5-1m',
  name: 'MiMo V2.5 · 1M',
  persona: {
    name: 'Mimo',
    tagline: 'MiMo V2.5 — custo reduzido, 1M contexto',
  },
  modelId: 'mimo-v2.5',
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,

  temperature: 0.3,
  reasoningTemperature: null,
  topP: 0.95,
  topK: null,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'enable_thinking',
  thinkingBudget: 8192,
  thinkingMandatory: false,

  preserveReasoning: true,
  supportsAttachments: true,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────

// ─────────────────────────────────────────────────
// Gemini 3.5 Flash / 3.1 Pro — Google (Vertex AI)
//
// SEM perfil próprio, o Gemini caía no default MiMo (supportsAttachments:
// false) e as imagens eram convertidas em marcador de texto em vez de
// image_url — o modelo respondia "não recebi nenhuma imagem" (visto em
// produção 2026-06-12). Gemini é multimodal nativo.
//
// Thinking: sempre-on no próprio modelo; NÃO usa enable_thinking (o
// parâmetro é ignorado pela Vertex). Os pensamentos só aparecem no stream
// quando a config ativa publica extraBody google.thinking_config.
// include_thoughts — e chegam como delta.content marcado com
// extra_content.google.thought=true (roteado em query.ts). thinkingParam
// null evita enviar lixo de outros dialetos.
// ─────────────────────────────────────────────────

const GEMINI_3_5_FLASH: ModelProfile = {
  id: 'gemini-3.5-flash',
  name: 'Gemini 3.5 Flash',
  persona: {
    name: 'Gemini Flash',
    tagline: 'Google Vertex — multimodal nativo, thinking sempre ativo',
  },
  modelId: 'google/gemini-3.5-flash',
  contextWindow: 1_048_576,
  maxOutputTokens: 65_536,

  temperature: 1.0,
  reasoningTemperature: null,
  topP: 0.95,
  topK: null,

  thinkingMode: 'mandatory',
  supportsThinking: true,
  thinkingParam: null,
  thinkingBudget: null,
  thinkingMandatory: true,

  preserveReasoning: false,
  supportsAttachments: true,
  supportsSearch: false,
  counterweights: [],
}

const GEMINI_3_1_PRO: ModelProfile = {
  ...GEMINI_3_5_FLASH,
  id: 'gemini-3.1-pro-preview',
  name: 'Gemini 3.1 Pro Preview',
  persona: {
    name: 'Gemini Pro',
    tagline: 'Google Vertex — topo de gama multimodal, thinking sempre ativo',
  },
  modelId: 'google/gemini-3.1-pro-preview',
}

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'glm-5.2': GLM_5_2,
  // DashScope/Alibaba Cloud (US) ainda pode reportar o id base 'glm-5' em
  // X-Model-Name (a doc internacional não lista o snapshot 5.2 datado) — alias
  // para o MESMO perfil, senão o lookup cairia no default ao rotear por
  // DashScope em vez da z.AI. Ambos os provedores servem o glm-5.2.
  'glm-5': GLM_5_2,
  'qwen3.7-max-2026-06-08': QWEN_3_7_MAX,
  // Alias do id antigo → mesmo perfil. O backend pode continuar a reportar
  // 'qwen3.7-max' em X-Model-Name até a config ativa ser republicada com o
  // snapshot datado; sem o alias o lookup falhava para o perfil default.
  'qwen3.7-max': QWEN_3_7_MAX,
  'mimo-v2.5-pro-1m': MIMO_V2_5_PRO_1M,
  'mimo-v2.5-1m': MIMO_V2_5_1M,
  // Gemini: registado sob o id do preset E sob o id raw com prefixo de
  // publisher — o X-TM-Model do worker reporta 'google/gemini-…' (é o que
  // o agentStore.modelName recebe), o /v1/me reporta o id do preset.
  'gemini-3.5-flash': GEMINI_3_5_FLASH,
  'google/gemini-3.5-flash': GEMINI_3_5_FLASH,
  'gemini-3.1-pro-preview': GEMINI_3_1_PRO,
  'google/gemini-3.1-pro-preview': GEMINI_3_1_PRO,
}

export const DEFAULT_MODEL_ID = 'mimo-v2.5-pro-1m'

export function getModelProfile(modelId: string): ModelProfile {
  return MODEL_PROFILES[modelId] || MODEL_PROFILES[DEFAULT_MODEL_ID]
}

export function getAllModelProfiles(): ModelProfile[] {
  // Dedupe por id — o registry tem chaves-alias (ex.: 'qwen3.7-max' →
  // mesmo perfil do snapshot datado) que não podem duplicar listagens.
  const seen = new Set<string>()
  return Object.values(MODEL_PROFILES).filter(p =>
    seen.has(p.id) ? false : (seen.add(p.id), true),
  )
}

/**
 * Returns the model profile for the user's billing plan.
 *
 * Post-refactor: always returns MiMo V2.5 Pro 1M regardless of plan.
 * The backend (Firestore) controls actual model routing via subscription_plans.
 */
export function getProfileForPlan(_plan: UserPlanName): ModelProfile {
  // Backend controls actual model via subscription_plans in Firestore.
  // Default fallback is MiMo V2.5 Pro 1M.
  return MIMO_V2_5_PRO_1M
}

/**
 * Build the thinking parameter object for the API request.
 * Returns null if thinking is not supported or not requested.
 *
 * Note: on the managed data-plane the IDE does NOT send thinking params
 * (buildThinkingConfig devolve undefined; o worker injeta via extraBody).
 * Esta função existe para callers diretos/BYOK e respeita a forma de cada
 * perfil: `thinking: { type }` (GLM-5.2/z.AI) vs `enable_thinking` (MiMo,
 * DashScope/Qwen).
 */
export function buildThinkingParam(
  profile: ModelProfile,
  enableThinking: boolean,
): Record<string, unknown> | null {
  if (!profile.supportsThinking || !profile.thinkingParam) return null

  const enabled = profile.thinkingMandatory ? true : enableThinking
  const budget = profile.thinkingBudget

  // GLM-5.2 (z.AI) usa o objeto `thinking: { type: 'enabled'|'disabled' }`.
  if (profile.thinkingParam === 'thinking') {
    return { thinking: { type: enabled ? 'enabled' : 'disabled' } }
  }

  // MiMo e DashScope/Qwen usam `enable_thinking: boolean`.
  const result: Record<string, unknown> = { enable_thinking: enabled }
  if (enabled && budget !== null) {
    result.max_thinking_tokens = budget
  }
  return result
}

/**
 * Build sampling params for the API request based on the model profile.
 */
export function buildSamplingParams(
  profile: ModelProfile,
  isThinking: boolean,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    temperature: isThinking && profile.reasoningTemperature !== null
      ? profile.reasoningTemperature
      : profile.temperature,
    top_p: (!isThinking && profile.topPNonThinking != null)
      ? profile.topPNonThinking
      : profile.topP,
    max_tokens: profile.maxOutputTokens,
  }

  if (profile.topK !== null) {
    params.top_k = profile.topK
  }

  if (profile.extraSamplingParams) {
    Object.assign(params, profile.extraSamplingParams)
  }

  return params
}
