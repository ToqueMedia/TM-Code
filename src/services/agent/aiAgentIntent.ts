/**
 * Detect "AI agent" / "conversational AI" intent in a user prompt.
 *
 * Why this exists: the BugHunterKimi session (2026-05-10/11) showed the
 * architect treating "agente de IA alimentado com o modelo Mercury 2" as a
 * FORM-based feature ("BugSubmissionForm") instead of a chat-based one. Two
 * separate correction turns were needed (form→chat at 10:14, chat→backend
 * integration at 10:31). Both were avoidable: the prompt explicitly named
 * an LLM (Mercury 2) and called the feature an "agente de IA".
 *
 * Detection signals (any combination triggers the AI-agent block in /plan):
 *   1. Named external LLM (Mercury, GPT-4, Claude, Gemini, etc.)
 *   2. Conversational-UX keywords ("agente de IA", "AI agent", "chat",
 *      "chatbot", "conversational", "talk to", etc.)
 *
 * Exported so unit tests can target the pure detector.
 */

export interface AiAgentIntent {
  /** Distinct LLM names mentioned in the prompt (canonical-cased). Empty
   *  array when no named model is detected. */
  namedModels: string[]
  /** True when the prompt mentions a chat-style / conversational UX. */
  isConversational: boolean
}

/**
 * Known LLM names and their canonical display form. Add new entries when
 * a model name surfaces in real prompts. Word-boundary matched so substrings
 * inside unrelated words (e.g. "mercury" inside a chemistry app prompt) only
 * trigger when the name appears as its own token.
 */
const LLM_CATALOG: Array<{ canonical: string; aliases: string[] }> = [
  // Anthropic
  { canonical: 'Claude', aliases: ['claude', 'claude 4', 'claude 4.7', 'claude opus', 'claude sonnet', 'claude haiku'] },
  // OpenAI
  { canonical: 'GPT-4', aliases: ['gpt-4', 'gpt4', 'gpt 4', 'gpt-4o', 'gpt4o'] },
  { canonical: 'GPT-3.5', aliases: ['gpt-3.5', 'gpt3.5', 'gpt 3.5', 'gpt-3', 'chatgpt'] },
  { canonical: 'OpenAI o1', aliases: ['o1', 'openai o1', 'o1-preview', 'o1-mini'] },
  // Google
  { canonical: 'Gemini', aliases: ['gemini', 'gemini pro', 'gemini ultra', 'gemini flash'] },
  // Meta
  { canonical: 'Llama', aliases: ['llama', 'llama 2', 'llama 3', 'llama 3.1', 'llama 4'] },
  // Mistral
  { canonical: 'Mistral', aliases: ['mistral', 'mixtral', 'mistral large', 'mistral small'] },
  // DeepSeek / Qwen / GLM / Inception
  { canonical: 'DeepSeek', aliases: ['deepseek', 'deepseek v3', 'deepseek v4', 'deepseek-v4-flash'] },
  { canonical: 'Qwen', aliases: ['qwen', 'qwen3', 'qwen 3', 'qwen3.6', 'qwen 3.6'] },
  { canonical: 'GLM', aliases: ['glm', 'glm-5', 'glm-5.2', 'glm-5.1', 'chatglm'] },
  { canonical: 'Mercury 2', aliases: ['mercury 2', 'mercury2', 'inception mercury'] },
  // Cohere / xAI
  { canonical: 'Cohere Command', aliases: ['cohere', 'command-r', 'command r'] },
  { canonical: 'Grok', aliases: ['grok', 'grok-2'] },
]

/**
 * Conversational-UX keywords. Multilingual; matched case-insensitively with
 * word boundaries. "chat" alone is included because Portuguese/English usage
 * of "chat" almost always implies chat-UX (vs the unrelated English verb).
 */
const CONVERSATIONAL_PATTERNS: RegExp[] = [
  // English
  /\bAI agent\b/i,
  /\bchat\s*bot\b/i,
  /\bchatbot\b/i,
  /\bconversational\b/i,
  /\btalk to (an? )?(ai|agent|bot)\b/i,
  /\bconverse with\b/i,
  /\b(virtual|ai)\s+assistant\b/i,
  /\bagentic\b/i,
  // Portuguese
  /\bagente de (i\.?a\.?|inteligência artificial)\b/i,
  /\bassistente virtual\b/i,
  /\bconversar com (um|uma|o|a) (agente|bot|ia|assistente)\b/i,
  // Spanish
  /\bagente de (i\.?a\.?|inteligencia artificial)\b/i,
  // The bare "chat" — risky (matches "live chat support", legitimately
  // conversational) but the false-positive case ("chat history" in a non-AI
  // app) is rare and the agent's architect prompt asks for clarification
  // anyway. Worth the false-positive risk.
  /\bchat\b/i,
]

export function detectAiAgentIntent(prompt: string): AiAgentIntent {
  if (!prompt) return { namedModels: [], isConversational: false }

  const lowered = prompt.toLowerCase()
  const seen = new Set<string>()
  const namedModels: string[] = []

  for (const entry of LLM_CATALOG) {
    for (const alias of entry.aliases) {
      // Word-boundary aware; escape regex meta chars in the alias.
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i')
      if (re.test(lowered)) {
        if (!seen.has(entry.canonical)) {
          seen.add(entry.canonical)
          namedModels.push(entry.canonical)
        }
        break // don't double-count this entry on multiple alias hits
      }
    }
  }

  const isConversational = CONVERSATIONAL_PATTERNS.some((re) => re.test(prompt))

  return { namedModels, isConversational }
}

/**
 * Build the architect-prompt block for AI-agent intent. Returns null when
 * neither a named model nor a conversational signal was detected — the
 * architect doesn't need the extra guidance.
 *
 * The block enforces three rules the architect would otherwise miss:
 *   1. Chat UX (back-and-forth), not form (fill once + submit).
 *   2. Backend handles the LLM call (frontend stays dumb so model API keys
 *      live server-side).
 *   3. Model integration is its own Implementation Phase, named explicitly.
 */
export function buildAiAgentPlatformLine(intent: AiAgentIntent): string | null {
  const { namedModels, isConversational } = intent
  if (namedModels.length === 0 && !isConversational) return null

  const modelClause = namedModels.length > 0
    ? `names ${namedModels.length === 1 ? 'an external LLM' : 'external LLMs'} (${namedModels.join(', ')}). `
    : ''
  const convoClause = isConversational
    ? `mentions a conversational / chat-style interface. `
    : ''

  return (
    `AI agent: the developer's idea ${modelClause}${convoClause}` +
    `Treat this as a CHAT-based UX (back-and-forth messages between user and agent), NOT a form-based one. ` +
    `Implementation requirements that must show up in PLAN.md: ` +
    `(a) frontend renders a chat thread (message bubbles + input box + scroll-to-latest), NOT a wizard or static form; ` +
    `(b) backend exposes a chat endpoint that proxies user messages to ${namedModels.length > 0 ? `the ${namedModels.join(' / ')} API` : 'the chosen LLM'}, returning the agent's reply (streamed if the model supports it); ` +
    `(c) LLM API keys stay SERVER-SIDE — the frontend NEVER calls the model directly, only the backend proxy; ` +
    `(d) capture the model name(s) in the Technical Decisions table with rationale (latency, pricing, capabilities); ` +
    `(e) the plan's phases (Files & Phases on FEATURE, Implementation Phases on PROJECT) must include a dedicated phase named "Model integration — <model name>" that wires the backend endpoint, error handling, and rate limiting. ` +
    `Do NOT propose: form-based bug submission, frontend-only AI logic, mock responses without a real model call, or omitting the model from the deployment topology.`
  )
}
