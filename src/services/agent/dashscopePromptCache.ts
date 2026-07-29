export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__TM_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

const EXPLICIT_CACHE_MIN_STATIC_BYTES = 4096

const DASHSCOPE_EXPLICIT_CACHE_MODELS = new Set([
  'qwen3.7-max',
  'qwen3.7-max-2026-05-20',
  'qwen3.7-max-2026-06-08',
  'qwen3.6-max-preview',
  'qwen3-max',
  'qwen3.7-plus',
  'qwen3.7-plus-2026-05-26',
  'qwen3.6-plus',
  'qwen3.5-plus',
  'qwen3.5-plus-2026-04-20',
  'qwen-plus',
  'qwen3.6-flash',
  'qwen3.5-flash',
  'qwen-flash',
  'qwen3-coder-plus',
  'qwen3-coder-flash',
  'qwen3-vl-plus',
  'qwen3-vl-flash',
  'deepseek-v3.2',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'kimi-k2.5',
])

function isDashScopeHost(baseURL: string | undefined): boolean {
  if (!baseURL) return false
  try {
    return /(^|\.)dashscope(-[a-z0-9]+)?\.aliyuncs\.com$/i.test(new URL(`https://${baseURL}`).hostname)
  } catch {
    try {
      return /(^|\.)dashscope(-[a-z0-9]+)?\.aliyuncs\.com$/i.test(new URL(baseURL).hostname)
    } catch {
      return false
    }
  }
}

function supportsExplicitCache(model: string, baseURL: string | undefined): boolean {
  if (DASHSCOPE_EXPLICIT_CACHE_MODELS.has(model)) return true
  if (model !== 'glm-5.1' || !baseURL) return false
  const host = baseURL.toLowerCase()
  return host === 'dashscope.aliyuncs.com' || host.includes('cn-beijing')
}

export function applyDashScopePromptCacheForByok(
  body: Record<string, unknown>,
  expectedHost: string,
): boolean {
  if (!isDashScopeHost(expectedHost)) return false
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, unknown>>)
    : null
  if (!messages) return false

  const model = typeof body.model === 'string' ? body.model : ''
  const canCache = supportsExplicitCache(model, expectedHost)
  let changed = false

  for (const msg of messages) {
    if (msg.role !== 'system' || typeof msg.content !== 'string') continue
    const content = msg.content
    const idx = content.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    if (idx === -1) {
      // Post-FASE-B (auditoria 2026-07-28): the builder splits at BUILD time and
      // the marker never reaches the transport, so "no marker" is now the normal
      // case — it means the system message already IS the byte-stable block.
      // Before this branch existed the `continue` below made explicit caching
      // dead code for every managed/BYOK DashScope model.
      if (!canCache || content.length < EXPLICIT_CACHE_MIN_STATIC_BYTES) continue
      msg.content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
      changed = true
      continue
    }

    const before = content.slice(0, idx).trimEnd()
    const after = content.slice(idx + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).trimStart()
    const applyCache = canCache && before.length >= EXPLICIT_CACHE_MIN_STATIC_BYTES

    if (applyCache) {
      const blocks: Array<Record<string, unknown>> = [
        { type: 'text', text: before, cache_control: { type: 'ephemeral' } },
      ]
      if (after.length > 0) blocks.push({ type: 'text', text: after })
      msg.content = blocks
    } else {
      msg.content = before + (before && after ? '\n\n' : '') + after
    }
    changed = true
  }

  return changed
}
