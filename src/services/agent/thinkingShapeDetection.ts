/**
 * BYOK thinking-param shape detection — per-host table.
 *
 * The shape of the `disable reasoning` parameter is host-specific:
 *   - OpenRouter   : `reasoning: { exclude: true }`
 *   - Xiaomi MiMo  : `chat_template_kwargs: { enable_thinking: false }`
 *   - Anthropic    : `thinking: { type: 'disabled' }`
 *   - DashScope/Qwen: `enable_thinking: false`
 *   - Google Gemini: `reasoning_effort: 'low'` (via OpenAI-compat /v1beta/openai/)
 *   - OpenAI        : `reasoning_effort: 'minimal'`
 *   - StepFun       : `reasoning_effort`
 *   - Moonshot Kimi: `thinking: { enabled: false }` (Kimi extension; only on K2.5 / K2.6)
 *
 * The catalog can ship the wrong shape (we saw Mimo-on-OpenRouter wired
 * with the OpenAI shape — the model silently ignored the param and kept
 * reasoning). The host that ACTUALLY receives the request is the ground
 * truth, so this detector wins over the catalog's hint.
 *
 * Lives in its own module (no Tauri / React / store imports) so the
 * lookup is pure-function testable.
 */
export type ThinkingShape =
  | 'anthropic'
  | 'openai_reasoning_effort'
  | 'qwen_enable_thinking'
  | 'gemini_thinking_budget'
  | 'openrouter_reasoning'
  | 'mimo_chat_template_kwargs'
  | 'moonshot_thinking'

/**
 * Hostname patterns → shape. We match the URL's hostname (not the full
 * URL string) to avoid spoofing like `https://evil.com/?openrouter.ai` —
 * the host is what actually receives the request, the rest is noise.
 * Each entry: `match(hostname)` returns true iff the host belongs to
 * this upstream family.
 */
const SHAPE_RULES: ReadonlyArray<{
  match: (hostname: string) => boolean
  shape: ThinkingShape
}> = [
  { match: (h) => h === 'openrouter.ai' || h.endsWith('.openrouter.ai'), shape: 'openrouter_reasoning' },
  // Gutlawb gateway (proxies Xiaomi MiMo models) + legacy xiaomimimo.com host.
  { match: (h) => h === 'opengateway.gitlawb.com' || h.endsWith('.gitlawb.com') || h === 'xiaomimimo.com' || h.endsWith('.xiaomimimo.com') || h === 'mimo.xiaomi.com', shape: 'mimo_chat_template_kwargs' },
  { match: (h) => h === 'api.anthropic.com', shape: 'anthropic' },
  // DashScope has regional variants — dashscope.aliyuncs.com (CN) and
  // dashscope-intl.aliyuncs.com.
  { match: (h) => /(^|\.)dashscope(-[a-z0-9]+)?\.aliyuncs\.com$/i.test(h), shape: 'qwen_enable_thinking' },
  // Google Gemini via OpenAI-compat endpoint (/v1beta/openai/). The endpoint
  // maps OpenAI-style reasoning_effort to Gemini's internal thinkingConfig.
  { match: (h) => h === 'generativelanguage.googleapis.com', shape: 'openai_reasoning_effort' },
  { match: (h) => h === 'api.openai.com', shape: 'openai_reasoning_effort' },
  { match: (h) => h === 'api.stepfun.ai' || h.endsWith('.stepfun.ai'), shape: 'openai_reasoning_effort' },
  // Moonshot Kimi — `thinking` Kimi-specific extension. The kimi-k2-thinking*
  // SKUs reason unconditionally; only k2.5 / k2.6 honor the toggle.
  { match: (h) => h === 'api.moonshot.ai' || h.endsWith('.moonshot.ai') || h === 'api.moonshot.cn' || h.endsWith('.moonshot.cn'), shape: 'moonshot_thinking' },
]

export interface ResolveThinkingHintInput {
  /** baseURL of the upstream the request will hit. */
  baseURL: string
  /** Catalog's claim that this model supports thinking. May be undefined for
   *  user-defined / Custom models. */
  catalogSupportsThinking?: boolean
  /** Catalog's declared shape. May be undefined or wrong; baseURL wins. */
  catalogShape?: ThinkingShape
}

export interface ResolvedThinkingHint {
  supportsThinking: boolean
  thinkingShape?: ThinkingShape
}

/**
 * Resolve the BYOK thinking hint from a baseURL + catalog inputs. The
 * resolution rule:
 *
 *   1. If the baseURL matches a known host (detectThinkingShapeFromBaseURL
 *      returns a shape), that shape wins AND `supportsThinking` is forced
 *      to `true` — the catalog is ignored. The catalog can be wrong in
 *      BOTH directions (we saw a user-defined Custom BYOK to
 *      api.xiaomimimo.com with supportsThinking=false, but the model
 *      reasoned anyway). For known reasoning-capable hosts, always send
 *      the disable param when thinking is off — it's a no-op on truly
 *      non-reasoning models but crucial when the catalog is wrong.
 *   2. If the baseURL is unknown, use the catalog's hint verbatim (both
 *      shape and supportsThinking). Self-hosted setups fall here — the
 *      catalog is the only signal we have.
 *
 * Pure function. Tested as a unit so the agentService integration
 * doesn't need its own end-to-end test for this path.
 */
export function resolveThinkingHint(input: ResolveThinkingHintInput): ResolvedThinkingHint {
  const detected = detectThinkingShapeFromBaseURL(input.baseURL)
  if (detected) {
    return { supportsThinking: true, thinkingShape: detected }
  }
  return {
    supportsThinking: input.catalogSupportsThinking ?? false,
    thinkingShape: input.catalogShape,
  }
}

export function detectThinkingShapeFromBaseURL(baseURL: string): ThinkingShape | null {
  if (!baseURL) return null
  // Parse to extract hostname. URL constructor handles trailing paths,
  // ports, queries; lowercases the host per spec. Bad input → null
  // (no shape detected, caller falls back to catalog or sends nothing).
  let hostname: string
  try {
    hostname = new URL(baseURL).hostname.toLowerCase()
  } catch {
    return null
  }
  for (const rule of SHAPE_RULES) {
    if (rule.match(hostname)) return rule.shape
  }
  return null
}
