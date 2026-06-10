/**
 * Model profiles — per-model configuration for TM Code agent.
 *
 * Supported models: GLM 5.1, Qwen 3.7 Max, MiMo V2.5 Pro 1M, MiMo V2.5 1M.
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
// GLM-5.1 — Alibaba China (DashScope)
//
// Zhipu GLM-5.1 via DashScope. 200K context window.
// Toggleable thinking via `enable_thinking` boolean.
// ─────────────────────────────────────────────────

const GLM_5_1: ModelProfile = {
  id: 'glm-5.1',
  name: 'GLM-5.1',
  persona: {
    name: 'GLM',
    tagline: 'Rastreamento de tarefas forte via DashScope',
  },
  modelId: 'glm-5.1',
  contextWindow: 200_000,
  maxOutputTokens: 16_384,

  // DashScope default sampling
  temperature: 0.7,
  reasoningTemperature: null,
  topP: 0.8,
  topK: null,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'enable_thinking',
  thinkingBudget: null,
  thinkingMandatory: false,

  preserveReasoning: false,
  supportsAttachments: false,
  supportsSearch: false,
  counterweights: [],
}

// ─────────────────────────────────────────────────
// Qwen 3.7 Max — Alibaba China (DashScope)
//
// Alibaba Cloud flagship. 1M context window, toggleable thinking.
// Sampling: temp 0.6, top_p 0.95, top_k 20.
// ─────────────────────────────────────────────────

const QWEN_3_7_MAX: ModelProfile = {
  id: 'qwen3.7-max',
  name: 'Qwen 3.7 Max',
  persona: {
    name: 'Qwen Max',
    tagline: 'Flagship Alibaba Cloud — 1M contexto, raciocínio toggleable',
  },
  modelId: 'qwen3.7-max',
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
  supportsAttachments: false,
  supportsSearch: false,
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

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'glm-5.1': GLM_5_1,
  'qwen3.7-max': QWEN_3_7_MAX,
  'mimo-v2.5-pro-1m': MIMO_V2_5_PRO_1M,
  'mimo-v2.5-1m': MIMO_V2_5_1M,
}

export const DEFAULT_MODEL_ID = 'mimo-v2.5-pro-1m'

export function getModelProfile(modelId: string): ModelProfile {
  return MODEL_PROFILES[modelId] || MODEL_PROFILES[DEFAULT_MODEL_ID]
}

export function getAllModelProfiles(): ModelProfile[] {
  return Object.values(MODEL_PROFILES)
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
 * Post-refactor: only handles `enable_thinking` shape for MiMo.
 */
export function buildThinkingParam(
  profile: ModelProfile,
  enableThinking: boolean,
): Record<string, unknown> | null {
  if (!profile.supportsThinking || !profile.thinkingParam) return null

  const enabled = profile.thinkingMandatory ? true : enableThinking
  const budget = profile.thinkingBudget

  // DashScope and MiMo both use `enable_thinking: boolean`.
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
