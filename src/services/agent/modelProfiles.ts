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
 * - 'toggleable': Model supports on/off via API param. User controls via
 *   Settings → thinkingEnabled. The agent does NOT decide thinking mode.
 * - 'mandatory': Model always thinks. Cannot be disabled.
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
  thinkingParam: 'enable_thinking' | 'thinking' | 'reasoning' | null
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

  /** Whether the model supports image/file attachments (multimodal input) */
  supportsAttachments: boolean
  /** Whether the model supports native web_search via the provider (DashScope Qwen only) */
  supportsSearch: boolean
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
  supportsAttachments: false,
  supportsSearch: false,
  modelSpecificPrompt: `Never start responses with filler ("Sure!", "Of course!", "Let me help you"). Go straight to the answer or code. Output only changed code — never repeat unchanged sections. Keep explanations under 2 sentences unless asked for detail.`,
}

const DEEPSEEK_V4_FLASH: ModelProfile = {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4-Flash',
  persona: { name: 'Nzinga Mbandi', tagline: 'Equilibrada e precisa — pensa antes de agir, excelente custo-benefício. Custo: 1x' },
  modelId: 'deepseek-v4-flash',
  // Upstream supports 1M tokens; we keep 256K / 128K-out for now and will
  // raise the caps once billing and latency numbers are validated.
  contextWindow: 262_144,
  maxOutputTokens: 131_072,

  temperature: 0.0,
  reasoningTemperature: null,
  topP: 1.0,
  topK: null,

  // V4-Flash supports three reasoning modes (Non-Think / Think-High / Think-Max).
  // We expose a toggle — user turns thinking on/off from Settings. DashScope
  // follows the `enable_thinking` boolean convention used by other models.
  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'enable_thinking',
  thinkingBudget: null,
  thinkingMandatory: false,

  // V4 accepts reasoning_content in subsequent turns (unlike V3.2 which rejected
  // it with 400). Preserving it gives the model access to its previous chain
  // of thought and improves multi-turn reasoning continuity.
  preserveReasoning: true,
  supportsAttachments: false,
  supportsSearch: true,  // DashScope DeepSeek native web_search via enable_search
  modelSpecificPrompt: '',
}

const DEEPSEEK_V4_PRO: ModelProfile = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4-Pro',
  persona: { name: 'Mãe Mwene', tagline: 'Raciocínio profundo e contexto largo — para tarefas complexas e multi-passo. Custo: 4x' },
  modelId: 'deepseek-v4-pro',
  // Upstream supports 1M tokens (Think Max recommends ≥384K). We cap at 256K
  // for parity with V4-Flash; raise once latency/billing numbers are validated.
  contextWindow: 262_144,
  maxOutputTokens: 131_072,

  // Official recommendation per HuggingFace model card (2026-04):
  // "For local deployment, we recommend setting the sampling parameters to
  // temperature = 1.0, top_p = 1.0." Same as DeepSeek's general guidance.
  temperature: 1.0,
  reasoningTemperature: 1.0,
  topP: 1.0,
  topPNonThinking: 1.0,
  topK: null,

  // Pro exposes the same three modes (Non-Think / Think-High / Think-Max)
  // via the `enable_thinking` boolean on DashScope. Default OFF — Think Max
  // is expensive (per-token cost + recommended ≥384K context); user opts in
  // from Settings when the task warrants it.
  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'enable_thinking',
  thinkingBudget: null,
  thinkingMandatory: false,

  // V4 family preserves reasoning_content across turns — same as V4-Flash.
  preserveReasoning: true,
  supportsAttachments: false,
  supportsSearch: true,
  modelSpecificPrompt: '',
}

const GLM_5_1: ModelProfile = {
  id: 'glm-5.1',
  name: 'GLM-5.1',
  persona: { name: 'Rei Mandente', tagline: 'Raciocínio avançado e persistência prolongada — forte em tarefas complexas e debugging. Custo: 4x' },
  // OpenRouter model ID — provider-agnostic, easy to swap providers later
  modelId: 'Z-AI/GLM-5.1',
  // OpenRouter reports 202,752 tokens; use conservative 200K for safety margin
  contextWindow: 200_000,
  maxOutputTokens: 32_768,

  // Official z.ai recommendations (from blog post / benchmark footnotes):
  //   SWE-Bench Pro (OpenHands coding agent): temp=1.0, top_p=0.95, 200K ctx
  //   Terminal-Bench (Claude Code think mode): temp=1.0, top_p=0.95
  //   NL2Repo: temp=1.0, top_p=1.0
  //   HLE: temp=1.0, top_p=0.95
  // We use temp=1.0 for both thinking and non-thinking (matches all evals).
  // top_p=0.95 for thinking mode, 0.95 for non-thinking (safer for tool
  // calling — top_p=1.0 allows sampling from the full probability distribution,
  // which can lead to malformed JSON arguments in tool calls).
  temperature: 1.0,
  reasoningTemperature: 1.0,
  topP: 0.95,
  topPNonThinking: 0.95,
  topK: null,

  // Thinking is TOGGLEABLE via the 'reasoning' parameter (OpenRouter format).
  // Per OpenRouter docs: reasoning mode can be enabled/disabled per request.
  // When enabled, preserves reasoning_details array for multi-turn continuity.
  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'reasoning',
  thinkingBudget: null,
  thinkingMandatory: false,

  // OpenRouter docs: "preserve and pass back the complete reasoning_details array
  // to maintain reasoning continuity" in multi-turn conversations.
  preserveReasoning: true,
  supportsAttachments: false,
  // GLM-5.1 has no native web_search. The frontend web_search tool delegates
  // the query to Qwen 3.6 Plus via a side-car sub-request (X-Request-Type: web_search),
  // and returns the result back to GLM-5.1 as the tool output.
  supportsSearch: true,
  modelSpecificPrompt: `You are TM Code Agent, a coding assistant built into TM Code IDE by Toque Media. You are NOT Claude, NOT ChatGPT, NOT any other assistant. Always identify yourself as TM Code Agent when asked.`,
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
  supportsAttachments: false,
  supportsSearch: false,
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

  // Thinking is TOGGLEABLE — controlled by the user via Settings, not by
  // the agent (request_thinking tool was removed). Routed via DashScope
  // (not native Moonshot API), so uses enable_thinking format.
  thinkingMode: 'toggleable',
  supportsThinking: true,
  thinkingParam: 'enable_thinking',
  thinkingBudget: null,
  thinkingMandatory: false,

  // CRITICAL: Moonshot docs require reasoning_content in assistant messages
  // during tool calling sequences. API returns 400 if stripped.
  preserveReasoning: true,
  supportsAttachments: true, // native multimodal (MoonViT)
  supportsSearch: false,
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
  supportsAttachments: false,
  supportsSearch: true,  // DashScope Qwen native web_search
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
  supportsAttachments: false,
  supportsSearch: false,
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
  supportsAttachments: true, // native multimodal (text + vision)
  supportsSearch: true,  // DashScope Qwen native web_search
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
  supportsAttachments: true, // native multimodal (text, image, audio, video, PDF)
  supportsSearch: false,
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
  supportsAttachments: false,
  supportsSearch: false,
  modelSpecificPrompt: '',
}

// ─────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  // 1x cost
  'mimo-v2-flash': MIMO_V2_FLASH,
  'deepseek-v4-flash': DEEPSEEK_V4_FLASH,
  'step-3.5-flash': STEP_3_5_FLASH,
  // 2x cost
  'qwen3-coder-next': QWEN3_CODER_NEXT,
  'minimax-m2.5': MINIMAX_M2_5,
  'qwen3.6-plus': QWEN3_6_PLUS,
  // 4x cost
  'glm-5': GLM_5,
  'glm-5.1': GLM_5_1,
  'kimi-k2.5': KIMI_K2_5,
  'deepseek-v4-pro': DEEPSEEK_V4_PRO,
  // 5x cost
  'gemini-3-flash': GEMINI_3_FLASH,
}

export const DEFAULT_MODEL_ID = 'deepseek-v4-flash'

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
//   pro / business-*x   → GLM-5.1 (toggleable thinking, 200K context)
//   multimodal (images) → Qwen 3.6 Plus handles image analysis, then GLM-5.1
// ─────────────────────────────────────────────────

/**
 * Returns the model profile for the user's billing plan.
 * Used by the frontend to configure thinking params, sampling, and
 * compression thresholds — NOT to select a model (the backend does that).
 *
 * Routing logic:
 * - explorer (free) → DeepSeek V3.2 (no thinking, 131K context)
 * - pro / business-*x → GLM-5.1 (thinking toggle, 200K context, strong reasoning)
 * - multimodal (images) → Qwen 3.6 Plus handles image analysis, then GLM-5.1 processes the result
 */
export function getProfileForPlan(plan: UserPlanName): ModelProfile {
  if (plan === 'explorer') return DEEPSEEK_V4_FLASH
  // All paid plans use GLM-5.1 as the primary model.
  // Qwen 3.6 Plus is reserved for multimodal (image) processing.
  return GLM_5_1
}

/**
 * Returns the multimodal model profile for image/file processing.
 * Qwen 3.6 Plus handles image analysis, then passes the description
 * + user prompt to the primary model (GLM-5.1).
 */
export function getMultimodalProfile(): ModelProfile {
  return QWEN3_6_PLUS
}

/**
 * Detects if a message contains multimodal content (images, files, etc.).
 * Returns true if the message has non-text content parts.
 */
export function hasMultimodalContent(message: string | Array<{ type: string }>): boolean {
  if (typeof message === 'string') return false
  return message.some(part => part.type !== 'text')
}

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

  // OpenRouter 'reasoning' format (GLM-5.1 on Z-AI/OpenRouter)
  if (profile.thinkingParam === 'reasoning') {
    return { reasoning: { enabled } }
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
