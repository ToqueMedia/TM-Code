/**
 * Model profiles — per-model configuration for the TM Code agent.
 *
 * Each profile defines sampling params, thinking toggle, system prompt
 * behavior, and model-specific instructions that maximize performance.
 */

export interface ModelPersona {
  /** Persona name shown to user (not the model name) */
  name: string
  /** Short tagline describing the persona's strength */
  tagline: string
}

/**
 * Thinking mode classification:
 * - 'toggleable': Model supports on/off via API param. The agent can activate via request_thinking tool.
 * - 'mandatory': Model always thinks. Cannot be disabled. No request_thinking tool shown.
 * - 'none': Model has no thinking/reasoning capability.
 */
export type ThinkingMode = 'toggleable' | 'mandatory' | 'none'

export interface ModelProfile {
  /** Unique profile identifier */
  id: string
  /** Display name (internal) */
  name: string
  /** User-facing persona (hides real model identity) */
  persona: ModelPersona
  /** Model ID sent to the API */
  modelId: string
  /** Context window in tokens */
  contextWindow: number
  /** Max output tokens */
  maxOutputTokens: number

  // ── Sampling ──
  /** Temperature for non-reasoning mode */
  temperature: number
  /** Temperature for reasoning mode (null = same as temperature) */
  reasoningTemperature: number | null
  /** Top-P for thinking mode (Qwen3: 0.95) */
  topP: number
  /** Top-P for non-thinking mode (Qwen3: 0.8). undefined/null = same as topP */
  topPNonThinking?: number | null
  topK: number | null
  /** Additional sampling params sent as-is in the request body */
  extraSamplingParams?: Record<string, unknown>

  // ── Thinking / Reasoning ──
  /** Thinking mode: 'toggleable' (on/off via API), 'mandatory' (always on), 'none' */
  thinkingMode: ThinkingMode
  /** Whether the model supports a thinking/reasoning toggle */
  supportsThinking: boolean
  /** Parameter name to enable thinking (varies by model) */
  thinkingParam: 'enable_thinking' | 'thinking' | null
  /** Max thinking tokens budget (null = no budget control) */
  thinkingBudget: number | null
  /** If true, thinking is always-on and cannot be disabled (MiniMax M2.5) */
  thinkingMandatory: boolean

  // ── Reasoning Preservation ──
  /**
   * Whether reasoning_content should be preserved in conversation history between turns.
   * - true: include reasoning_content in assistant messages sent to the API (Qwen 3.6+, Gemini)
   * - false: strip reasoning_content from history — model ignores or rejects it (DeepSeek, GLM, Kimi, Step)
   * Based on official documentation for each provider.
   */
  preserveReasoning: boolean

  // ── System Prompt Behavior ──
  /** If true, skip/minimize system prompt when thinking is active (DeepSeek) */
  skipSystemPromptInThinking: boolean
  /** Whether the model supports image/file attachments (multimodal input) */
  supportsAttachments: boolean
  /** Model-specific instructions appended to system prompt */
  modelSpecificPrompt: string
}

import type { UserPlanName } from '../../stores/billingStore'

// ─────────────────────────────────────────────────
// Model Profiles — Personas named after Angolan heroes
// (mimo-v2-flash uses a non-hero persona for Free tier)
// ─────────────────────────────────────────────────

const MIMO_V2_FLASH: ModelProfile = {
  id: 'mimo-v2-flash',
  name: 'MiMo V2 Flash',
  persona: { name: 'Free', tagline: 'Rápida para tarefas simples — edições, perguntas e protótipos rápidos. Custo: 1x' },
  modelId: 'mimo-v2-flash',
  contextWindow: 262_144,
  maxOutputTokens: 65_536,

  temperature: 0.3,
  reasoningTemperature: null,
  topP: 0.95,
  topPNonThinking: null,
  topK: null,

  // Thinking supported but DEGRADES quality at all temperatures — keep OFF
  thinkingMode: 'none',
  supportsThinking: false,
  thinkingParam: null,
  thinkingBudget: null,
  thinkingMandatory: false,

  preserveReasoning: false, // N/A — thinking disabled
  skipSystemPromptInThinking: false,
  supportsAttachments: false,
  modelSpecificPrompt: `Never start responses with filler ("Sure!", "Of course!", "Let me help you"). Go straight to the answer or code. Output only changed code — never repeat unchanged sections. Keep explanations under 2 sentences unless asked for detail.`,
}

const DEEPSEEK_V3_2: ModelProfile = {
  id: 'deepseek-v3.2',
  name: 'DeepSeek V3.2',
  persona: { name: 'Nzinga Mbandi', tagline: 'Equilibrada e precisa — pensa antes de agir, excelente custo-benefício. Custo: 1x' },
  modelId: 'deepseek-v3.2',
  contextWindow: 131_072,
  maxOutputTokens: 32_768,

  temperature: 0.0,
  reasoningTemperature: null,
  topP: 1.0,
  topK: null,

  // DeepSeek V3.2 on DashScope does NOT support thinking — the backend
  // strips enable_thinking/thinking/thinking_budget for this model
  // (proxy.ts MODELS_NO_THINKING). Profile must reflect reality.
  thinkingMode: 'none',
  supportsThinking: false,
  thinkingParam: null,
  thinkingBudget: null,
  thinkingMandatory: false,

  preserveReasoning: false, // DeepSeek docs: "API will return 400 if reasoning_content included"
  skipSystemPromptInThinking: false,
  supportsAttachments: false,
  modelSpecificPrompt: '',
}

const GLM_5: ModelProfile = {
  id: 'glm-5',
  name: 'GLM-5',
  persona: { name: 'Rei Mandume', tagline: 'Persistente e metódico — forte em debugging e execução passo-a-passo. Custo: 4x' },
  modelId: 'glm-5',
  contextWindow: 198_000,
  maxOutputTokens: 16_384,

  // Zhipu AI defaults: temp=0.95, top_p=0.7 (notably lower than industry standard)
  temperature: 0.95,
  reasoningTemperature: 0.95,
  topP: 0.7,
  topK: null,

  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'enable_thinking',
  thinkingBudget: null,
  thinkingMandatory: false,

  preserveReasoning: true, // ZhipuAI docs: clear_thinking param — during tool calling sequences (our loop), preservation required
  skipSystemPromptInThinking: false,
  supportsAttachments: false,
  modelSpecificPrompt: `You are TM Code Agent, a coding assistant built into TM Code IDE by Toque Media. You are NOT Claude, NOT ChatGPT, NOT any other assistant. Always identify yourself as TM Code Agent when asked.`,
}

const KIMI_K2_5: ModelProfile = {
  id: 'kimi-k2.5',
  name: 'Kimi K2.5',
  persona: { name: 'Agostinho Neto', tagline: 'Qualidade máxima de código — compreende imagens e lê projectos enormes. Custo: 4x' },
  modelId: 'kimi-k2.5',
  contextWindow: 262_144,
  maxOutputTokens: 65_536,

  // Kimi K2.5 benchmark best practices: temperature=1.0, top_p=0.95.
  // These are recommended by Moonshot for best reasoning quality.
  temperature: 1.0,
  reasoningTemperature: null,
  topP: 0.95,
  topK: null,

  // Thinking is TOGGLEABLE: Turn 1 ON so the model reasons about the task,
  // then the model itself decides via request_thinking whether to keep it ON
  // for subsequent turns based on the complexity of the user's request.
  // Routed via DashScope (not native Moonshot API), so uses enable_thinking format.
  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'enable_thinking',
  thinkingBudget: null,
  thinkingMandatory: false,

  // CRITICAL: Moonshot docs require reasoning_content in assistant messages
  // during tool calling sequences. API returns 400 if stripped.
  preserveReasoning: true,
  skipSystemPromptInThinking: false,
  supportsAttachments: true, // native multimodal (MoonViT)
  modelSpecificPrompt: '',
}

const QWEN3_CODER_NEXT: ModelProfile = {
  id: 'qwen3-coder-next',
  name: 'Qwen3 Coder Next',
  persona: { name: 'Ngola Kiluange', tagline: 'Especialista em código — veloz, domina 358 linguagens, vai directo ao ponto. Custo: 2x' },
  modelId: 'qwen3-coder-next',
  contextWindow: 262_144,
  maxOutputTokens: 65_536,

  // Qwen3 official: temp=0.7 non-thinking, top_p=0.8, top_k=20
  temperature: 0.7,
  reasoningTemperature: null,
  topP: 0.8,
  topK: 20,

  thinkingMode: 'none',
  supportsThinking: false,
  thinkingParam: null,
  thinkingBudget: null,
  thinkingMandatory: false,

  preserveReasoning: false, // N/A — thinking disabled
  skipSystemPromptInThinking: false,
  supportsAttachments: false,
  modelSpecificPrompt: `Be concise in explanations. Output code changes directly without verbose commentary. When editing files, output only the changed code — do not repeat unchanged sections.`,
}

const MINIMAX_M2_5: ModelProfile = {
  id: 'minimax-m2.5',
  name: 'MiniMax M2.5',
  persona: { name: 'Ekuikui II', tagline: 'O mais forte em engenharia complexa — resolve o que outros não conseguem. Custo: 2x' },
  modelId: 'minimax-m2.5',
  contextWindow: 196_608,
  maxOutputTokens: 32_768,

  // MiniMax default: temp=0.9, top_p=0.95
  temperature: 0.9,
  reasoningTemperature: null,
  topP: 0.95,
  topK: null,

  thinkingMode: 'mandatory',
  supportsThinking: true,
  thinkingParam: 'enable_thinking',
  thinkingBudget: 4096,
  thinkingMandatory: true,

  preserveReasoning: true, // MiniMax docs: strongly recommend preserving reasoning between turns
  skipSystemPromptInThinking: false,
  supportsAttachments: false,
  modelSpecificPrompt: `Be concise. Output only the code changes needed. Do not add explanatory comments unless asked. Do not overthink simple tasks.`,
}

const QWEN3_6_PLUS: ModelProfile = {
  id: 'qwen3.6-plus',
  name: 'Qwen 3.6 Plus',
  persona: { name: 'Hoji Ya Henda', tagline: 'O mais completo — vê imagens, lê projectos inteiros e executa com decisão. Custo: 2x' },
  modelId: 'qwen3.6-plus',
  // DashScope official: 1M context window (confirmed via help.aliyun.com model listing)
  contextWindow: 1_000_000,
  maxOutputTokens: 65_536,

  // Qwen3 official (HuggingFace Qwen/Qwen3-235B-A22B):
  //   Thinking: temp=0.6, top_p=0.95, top_k=20
  //   Non-thinking: temp=0.7, top_p=0.8, top_k=20
  temperature: 0.7,
  reasoningTemperature: 0.6,
  topP: 0.95,
  topPNonThinking: 0.8,
  topK: 20,

  // Thinking is user-controlled via Settings toggle (not agent-controlled).
  // Qwen3 has thinking ON by default per official docs.
  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'enable_thinking',
  thinkingBudget: null,
  thinkingMandatory: false,

  // Qwen3 official (HuggingFace): "In multi-turn conversations, store only
  // the final output (not thinking content) in conversation history."
  // This means reasoning_content should NOT be preserved between turns.
  preserveReasoning: false,
  skipSystemPromptInThinking: false,
  supportsAttachments: true, // native multimodal (text + vision)
  modelSpecificPrompt: `Be decisive and direct. Reach conclusions quickly — do not overthink simple tasks. Output only changed code, never repeat unchanged sections. Keep explanations under 2 sentences unless asked for detail.`,
}

const GEMINI_3_FLASH: ModelProfile = {
  id: 'gemini-3-flash',
  name: 'Gemini 3 Flash',
  persona: { name: 'Simione Mucune', tagline: 'Contexto enorme, aceita tudo — texto, imagens, PDFs e vídeo. Custo: 5x' },
  modelId: 'gemini-3-flash',
  contextWindow: 1_048_576,
  maxOutputTokens: 65_536,

  // Google docs: "strongly recommend keeping temperature at default 1.0"
  temperature: 1.0,
  reasoningTemperature: 1.0,
  topP: 0.95,
  topK: null,
  extraSamplingParams: { thinking_level: 'medium' },

  thinkingMode: 'mandatory', // Gemini thinking_level is not binary toggle — always applies
  supportsThinking: true,
  thinkingParam: null, // Gemini uses thinking_level via extraSamplingParams, not enable_thinking
  thinkingBudget: null,
  thinkingMandatory: false,

  preserveReasoning: true, // Google docs: "always pass all signatures back" for thought context
  skipSystemPromptInThinking: false,
  supportsAttachments: true, // native multimodal (text, image, audio, video, PDF)
  modelSpecificPrompt: '',
}

const STEP_3_5_FLASH: ModelProfile = {
  id: 'step-3.5-flash',
  name: 'Step 3.5 Flash',
  persona: { name: 'Deolinda Rodrigues', tagline: 'Pensa sempre antes de responder — raciocínio nativo a custo mínimo. Custo: 1x' },
  modelId: 'step-3.5-flash',
  contextWindow: 262_144,
  maxOutputTokens: 32_768,

  temperature: 1.0,
  reasoningTemperature: null,
  topP: 0.95,
  topK: null,

  thinkingMode: 'mandatory', // Step 3.5 Flash has native reasoning — always active
  supportsThinking: true,
  thinkingParam: null, // reasoning is built-in, no toggle parameter
  thinkingBudget: null,
  thinkingMandatory: true,

  preserveReasoning: false, // StepFun: no documentation on preserving reasoning between turns
  skipSystemPromptInThinking: false,
  supportsAttachments: false,
  modelSpecificPrompt: '',
}

// ─────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  // 1x cost
  'mimo-v2-flash': MIMO_V2_FLASH,
  'deepseek-v3.2': DEEPSEEK_V3_2,
  'step-3.5-flash': STEP_3_5_FLASH,
  // 2x cost
  'qwen3-coder-next': QWEN3_CODER_NEXT,
  'minimax-m2.5': MINIMAX_M2_5,
  'qwen3.6-plus': QWEN3_6_PLUS,
  // 4x cost
  'glm-5': GLM_5,
  'kimi-k2.5': KIMI_K2_5,
  // 5x cost
  'gemini-3-flash': GEMINI_3_FLASH,
}

export const DEFAULT_MODEL_ID = 'deepseek-v3.2'

// Dead code — kept for potential reactivation
export const FREE_MODEL_ID = 'mimo-v2-flash'
export function getModelProfile(modelId: string): ModelProfile {
  return MODEL_PROFILES[modelId] || MODEL_PROFILES[DEFAULT_MODEL_ID]
}
export function getAllModelProfiles(): ModelProfile[] {
  return Object.values(MODEL_PROFILES)
}

// ─────────────────────────────────────────────────
// Plan-based profile lookup (replaces model selector)
// The model is decided by the backend based on the user's plan.
// The frontend uses this to configure thinking/sampling/compression.
//
//   explorer (free)     → DeepSeek V3.2 (no thinking, 131K context)
//   pro / business-*x   → Kimi K2.5 (mandatory thinking, 262K context, multimodal)
// ─────────────────────────────────────────────────

/**
 * Returns the model profile for the user's billing plan.
 * Used by the frontend to configure thinking params, sampling, and
 * compression thresholds — NOT to select a model (the backend does that).
 */
export function getProfileForPlan(plan: UserPlanName): ModelProfile {
  if (plan === 'explorer') return DEEPSEEK_V3_2
  // All paid plans use Qwen 3.6 Plus.
  return QWEN3_6_PLUS
}

/** @deprecated Dead code — model selection moved to backend. Kept for migration compat. */
export function getModelsForPlan(_plan: UserPlanName): ModelProfile[] { return [DEEPSEEK_V3_2, QWEN3_6_PLUS] }
/** @deprecated Dead code — model selection moved to backend. Kept for migration compat. */
export function getDefaultModelForPlan(plan: UserPlanName): string { return plan === 'explorer' ? 'deepseek-v3.2' : 'qwen3.6-plus' }
/** @deprecated Dead code — model selection moved to backend. Kept for migration compat. */
export function isModelAvailableForPlan(_modelId: string, _plan: UserPlanName): boolean { return true }

/**
 * Build the thinking parameter object for the API request.
 * Returns null if thinking is not supported or not requested.
 */
export function buildThinkingParam(
  profile: ModelProfile,
  enableThinking: boolean,
): Record<string, unknown> | null {
  if (!profile.supportsThinking || !profile.thinkingParam) return null

  // Mandatory thinking — always send enabled regardless of the flag
  const enabled = profile.thinkingMandatory ? true : enableThinking

  if (profile.thinkingParam === 'enable_thinking') {
    return { enable_thinking: enabled }
  }

  // 'thinking' format (e.g., Anthropic-style)
  return {
    thinking: { type: enabled ? 'enabled' : 'disabled' },
  }
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
    // Qwen3: top_p changes between thinking (0.95) and non-thinking (0.8).
    // Other models: topPNonThinking is null/undefined → use topP for both.
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

  // Thinking budget
  if (isThinking && profile.thinkingBudget !== null) {
    params.thinking_budget = profile.thinkingBudget
  }

  return params
}
