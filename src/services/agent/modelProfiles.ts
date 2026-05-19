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
 * A model-specific counterweight rule (technique #6 — counterweight bullets
 * gated by model). Each entry documents WHY it exists (which fine-tune drift
 * it counters), WHEN it was added, and WHEN to review it for removal.
 *
 * Without `reviewAfter`, counterweights accumulate forever — every model
 * launch is a regression, and every rule that no longer applies becomes
 * dead text in the prompt budget. The date is a hard prompt to revisit:
 * when the upstream model rolls forward, walk the list and either un-gate
 * (if the drift is gone in the new version) or extend the review date
 * after re-validating against the new version.
 */
export interface Counterweight {
  /** The rule itself — what the model should DO. Positive framing preferred
   *  (see feedback_positive_prompts memory): "Always identify yourself as X"
   *  beats "Don't claim to be Y". */
  rule: string
  /** Which fine-tune drift this counters. Cite the model + version
   *  (e.g. "GLM-5.1 identity contamination from upstream Claude data"). */
  addedFor: string
  /** ISO date (YYYY-MM-DD) when this was added. Surfaces stale rules. */
  addedOn: string
  /** ISO date (YYYY-MM-DD) when this should be reviewed for un-gating.
   *  Typically `addedOn + 90 days`. The review is a prompt to either
   *  drop the rule, extend the date, or escalate for A/B validation. */
  reviewAfter: string
}

/**
 * Thinking mode classification:
 * - 'toggleable': Model accepts an on/off param. We always send ON when
 *   the profile's `supportsThinking` is true — the user toggle was
 *   removed (claude-vaz parity). Reasoning is preserved between turns.
 * - 'mandatory': Model always thinks regardless of the param. We surface
 *   a static "⚡ Thinking" badge in the chat chrome so the user knows.
 * - 'none': Model has no thinking/reasoning capability — reasoning blocks
 *   never render in the chat UI.
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
  /**
   * Model-specific counterweight rules. Rendered into the system prompt by
   * `renderCounterweights(profile)` so call sites can stay agnostic of the
   * shape. Empty array means the model has no observed drift requiring
   * counter-bullets — that is the goal state, NOT a missing feature.
   */
  counterweights: Counterweight[]
}

/**
 * Render a profile's counterweights as a system-prompt section. Returns an
 * empty string when there are none, so call sites can concat without a
 * conditional. Stale rules (where `reviewAfter` is in the past) are still
 * included — the review date is a prompt for human attention, not a kill
 * switch. The reviewing engineer either extends the date or removes the
 * rule, but we never silently drop a rule the prompt is depending on.
 *
 * The rendered shape is plain bullets so it slots cleanly into the existing
 * `getModelSpecificSection(ctx)` call site:
 *
 *     - <rule 1>
 *     - <rule 2>
 */
export function renderCounterweights(profile: ModelProfile): string {
  if (!profile.counterweights || profile.counterweights.length === 0) return ''
  return profile.counterweights.map(c => `- ${c.rule}`).join('\n')
}

import type { UserPlanName } from '../../stores/billingStore'

// ─────────────────────────────────────────────────
// Model Profiles — Official models only (2026-05-02)
//
// Frontend keeps a profile per default-routable model. Backend is the source
// of truth for plan→model routing (admin-controlled in Firestore); the
// frontend's per-plan profile only defines max_tokens and sampling for the
// request body. Backend (proxy.ts) clamps max_tokens per upstream when needed.
//
// Official coder models: DeepSeek V4-Flash, GLM-5.1, Step 3.5 Flash, Kimi K2.6,
// MiniMax M2.7. Multimodal handler: Qwen3.6-Plus.
// ─────────────────────────────────────────────────

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
  // V4-Flash has no observed identity-contamination or behaviour-drift
  // regressions against its upstream baseline. Goal state — keep this empty.
  counterweights: [],
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
  counterweights: [
    {
      rule: 'You are the coding agent inside TM Code, built by Toque Media. Identify yourself as such when asked — never as Claude, ChatGPT, GPT, Gemini, or any other model or provider.',
      addedFor: 'GLM-5.1 occasionally hallucinates "I am Claude" / "I am GPT-4" from upstream model-output contamination in its training data',
      addedOn: '2026-05-02',
      reviewAfter: '2026-08-02',
    },
  ],
}

// ─────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────

// Frontend profile registry — used ONLY for request-body shape (sampling +
// thinking-param format). The actual upstream model is admin-managed in
// Firestore subscription_plans/{planId}.ideModel; the proxy resolves at
// request time and clamps anything tighter per upstream.
//
// Only V4-Flash and GLM-5.1 are kept here because those are the two shapes
// `getProfileForPlan(plan)` returns. Other catalog entries (Kimi K2.6-direct,
// MiniMax M2.7-direct, Step 3.5 Flash 2603) are admin escape hatches —
// when the admin reroutes there, the proxy's per-model translators handle
// whichever shape the frontend sends.
//
// Multimodal (images): handled server-side in `multimodal.ts` — Qwen 3.6 Plus
// turns image_url blocks into text, then the result is forwarded to the plan
// model. The frontend does NOT swap profiles for image messages.
export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'deepseek-v4-flash': DEEPSEEK_V4_FLASH,
  'glm-5.1':           GLM_5_1,
}

export const DEFAULT_MODEL_ID = 'deepseek-v4-flash'

export function getModelProfile(modelId: string): ModelProfile {
  return MODEL_PROFILES[modelId] || MODEL_PROFILES[DEFAULT_MODEL_ID]
}
export function getAllModelProfiles(): ModelProfile[] {
  return Object.values(MODEL_PROFILES)
}

/**
 * Returns the sampling profile for the user's billing plan. Used by the
 * frontend to shape the request body (thinking params, sampling, compression
 * thresholds) — NOT to select a model. The actual model is admin-controlled
 * via Firestore subscription_plans/{planId}.ideModel; the proxy resolves at
 * request time.
 *
 *   explorer / vibe → V4-Flash shape (sends `enable_thinking`)
 *   pro / max       → GLM-5.1 shape (sends `reasoning: { enabled }`)
 *
 * If admin reroutes a plan to a different catalog entry (e.g. kimi-k2.6-direct
 * or step-3.5-flash-2603), the proxy's per-model translators/scrubbers
 * normalize whichever shape we send.
 */
export function getProfileForPlan(plan: UserPlanName): ModelProfile {
  if (plan === 'explorer' || plan === 'vibe') return DEEPSEEK_V4_FLASH
  return GLM_5_1
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
