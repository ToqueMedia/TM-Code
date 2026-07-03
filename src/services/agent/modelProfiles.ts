/**
 * Model profiles — per-model *capability* table for the TM Code agent.
 *
 * IMPORTANTE (arquitetura): a IDE NÃO escolhe nem configura modelos. O modelo
 * ativo, o provedor, a chave, o sampling e a forma do thinking vivem na config
 * KV do data-plane (worker ai-pass-through) e são publicados pelo control-plane.
 * O data-plane reporta o nome do modelo em `X-TM-Model` e a janela real em
 * `X-Model-Context-Window`.
 *
 * Esta tabela existe APENAS para preencher o que esses headers NÃO dizem: as
 * capacidades do modelo (visão, thinking, max output, web search nativa) e a
 * janela de fallback pré-handshake. É indexada pelo nome reportado pelo
 * data-plane; quando o nome é desconhecido, cai em getProfileForPlan().
 *
 * Quando o data-plane passar a emitir headers de capacidade
 * (X-Model-Supports-Vision/Thinking/Max-Output-Tokens), esta tabela colapsa
 * para um único default e adicionar/remover modelos deixa de tocar na IDE.
 */

import type { UserPlanName } from '../../stores/billingStore'

// ── Types ──

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
  modelId: string
  contextWindow: number
  maxOutputTokens: number

  // ── Thinking / Reasoning ──
  thinkingMode: ThinkingMode
  supportsThinking: boolean
  thinkingMandatory: boolean

  // ── Features ──
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
// O data-plane roteia para z.AI oficial OU para DashScope/Alibaba Cloud (US)
// consoante a config ativa em KV — ambos expõem o mesmo glm-5.2. 1M de
// contexto, até 128K de saída. Thinking ON por defeito; a forma do parâmetro
// (z.AI: `thinking:{type}`; DashScope: `enable_thinking`) é injetada pelo
// worker via extraBody — a IDE nunca a envia. Text-only: visão pelo sidecar.
// ─────────────────────────────────────────────────

const GLM_5_2: ModelProfile = {
  id: 'glm-5.2',
  name: 'GLM-5.2',
  modelId: 'glm-5.2',
  contextWindow: 1_000_000,
  maxOutputTokens: 131_072,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: false,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// DeepSeek V4 Pro — DeepSeek oficial. 1M contexto, até 384K de saída.
// Thinking toggleable via config do data-plane (`thinking:{type}` +
// `reasoning_effort`) e text-only; visão/pesquisa seguem por sidecars.
// ─────────────────────────────────────────────────

const DEEPSEEK_V4_PRO: ModelProfile = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro',
  modelId: 'deepseek-v4-pro',
  contextWindow: 1_000_000,
  maxOutputTokens: 393_216,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: false,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// Qwen 3.7 Max (snapshot 2026-06-08) — Alibaba China (DashScope)
//
// Flagship Alibaba Cloud. 1M contexto, Visual Understanding + web search
// NATIVOS (supportsAttachments/supportsSearch ligados dispensam os sidecars).
// ─────────────────────────────────────────────────

const QWEN_3_7_MAX: ModelProfile = {
  id: 'qwen3.7-max-2026-06-08',
  name: 'Qwen 3.7 Max',
  modelId: 'qwen3.7-max-2026-06-08',
  contextWindow: 1_000_000,
  maxOutputTokens: 65_536,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: true,
  supportsSearch: true,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// MiMo V2.5 Pro 1M — Xiaomi. 1M contexto, thinking toggleable.
// ─────────────────────────────────────────────────

const MIMO_V2_5_PRO_1M: ModelProfile = {
  id: 'mimo-v2.5-pro-1m',
  name: 'MiMo V2.5 Pro 1M',
  modelId: 'mimo-v2.5-pro',
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: false,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// MiMo V2.5 1M — Xiaomi. Irmão menor, mesma forma de thinking.
// ─────────────────────────────────────────────────

const MIMO_V2_5_1M: ModelProfile = {
  id: 'mimo-v2.5-1m',
  name: 'MiMo V2.5 · 1M',
  modelId: 'mimo-v2.5',
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: true,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// Gemini 3.5 Flash / 3.1 Pro — Google (Vertex AI)
//
// Multimodal nativo, thinking SEMPRE ativo (mandatory) no próprio modelo — a
// IDE não envia params de thinking; os pensamentos chegam no stream quando a
// config ativa publica google.thinking_config.include_thoughts.
// ─────────────────────────────────────────────────

const GEMINI_3_5_FLASH: ModelProfile = {
  id: 'gemini-3.5-flash',
  name: 'Gemini 3.5 Flash',
  modelId: 'google/gemini-3.5-flash',
  contextWindow: 1_048_576,
  maxOutputTokens: 65_536,

  thinkingMode: 'mandatory',
  supportsThinking: true,
  thinkingMandatory: true,

  supportsAttachments: true,
  supportsSearch: false,
  counterweights: [],
}

const GEMINI_3_1_PRO: ModelProfile = {
  ...GEMINI_3_5_FLASH,
  id: 'gemini-3.1-pro-preview',
  name: 'Gemini 3.1 Pro Preview',
  modelId: 'google/gemini-3.1-pro-preview',
}

// ─────────────────────────────────────────────────
// Kimi K2.7 Code — Moonshot/Kimi via Alibaba Cloud DashScope.
//
// A página oficial do DashScope lista Text Generation, Visual Understanding e
// Deep Thinking. Capacidades: input text/image/video, function calling, cache,
// structured output e web search. Esta tabela só expõe os campos que a IDE
// entende hoje: anexos, thinking e search.
// ─────────────────────────────────────────────────

const KIMI_K2_7_CODE: ModelProfile = {
  id: 'kimi-k2.7-code',
  name: 'Kimi K2.7 Code',
  modelId: 'kimi-k2.7-code',
  contextWindow: 262_144,
  maxOutputTokens: 32_768,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingMandatory: false,

  supportsAttachments: true,
  supportsSearch: true,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'glm-5.2': GLM_5_2,
  // DashScope/Alibaba Cloud (US) ainda pode reportar o id base 'glm-5' em
  // X-TM-Model — alias para o MESMO perfil, senão o lookup cairia no default.
  'glm-5': GLM_5_2,
  'deepseek-v4-pro': DEEPSEEK_V4_PRO,
  'qwen3.7-max-2026-06-08': QWEN_3_7_MAX,
  // Alias do id antigo → mesmo perfil enquanto a config ativa não republicar
  // o snapshot datado.
  'qwen3.7-max': QWEN_3_7_MAX,
  'mimo-v2.5-pro-1m': MIMO_V2_5_PRO_1M,
  'mimo-v2.5-1m': MIMO_V2_5_1M,
  // Gemini: id do preset E id raw com prefixo de publisher (X-TM-Model reporta
  // 'google/gemini-…'; o /v1/me reporta o id do preset).
  'gemini-3.5-flash': GEMINI_3_5_FLASH,
  'google/gemini-3.5-flash': GEMINI_3_5_FLASH,
  'gemini-3.1-pro-preview': GEMINI_3_1_PRO,
  'google/gemini-3.1-pro-preview': GEMINI_3_1_PRO,
  'kimi-k2.7-code': KIMI_K2_7_CODE,
}

export const DEFAULT_MODEL_ID = 'mimo-v2.5-pro-1m'

export function getModelProfile(modelId: string): ModelProfile {
  return MODEL_PROFILES[modelId] || MODEL_PROFILES[DEFAULT_MODEL_ID]
}

/**
 * Returns the model profile for the user's billing plan.
 *
 * Post-refactor: always returns MiMo V2.5 Pro 1M regardless of plan. The
 * data-plane (KV config) controls actual model routing; this is only the
 * pre-handshake / unknown-model fallback.
 */
export function getProfileForPlan(_plan: UserPlanName): ModelProfile {
  return MIMO_V2_5_PRO_1M
}
