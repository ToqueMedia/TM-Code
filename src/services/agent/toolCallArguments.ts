/**
 * `tool_calls[].function.arguments` no fio OpenAI-compat.
 *
 * Cloudflare Workers AI (e vários gateways) exigem uma STRING de JSON
 * válido. O round-trip nativo pode trazer: objecto já parseado, JSON
 * truncado pelo stream, ou `"[object Object]"` de chunks não-string.
 * Um 400 disto é DETERMINÍSTICO — o mesmo corpo falha sempre. Retry
 * sem reparar só mata o run. Sanear no limite do fio (toOpenAIMessages)
 * é a recuperação.
 */

export function isValidJsonString(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

/** Fecha aspas/chavetas que o stream cortou a meio. Null se não der. */
export function repairPartialJson(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
  s = s.replace(/,\s*([}\]])/g, '$1')

  let inString = false
  let escape = false
  const opens: string[] = []
  for (const ch of s) {
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') opens.push(ch)
    else if (ch === '}' && opens[opens.length - 1] === '{') opens.pop()
    else if (ch === ']' && opens[opens.length - 1] === '[') opens.pop()
  }
  if (inString) s += '"'
  for (let i = opens.length - 1; i >= 0; i--) {
    s += opens[i] === '{' ? '}' : ']'
  }
  return isValidJsonString(s) ? s : null
}

/** Sempre uma string que `JSON.parse` aceita. */
export function coerceFunctionArguments(raw: unknown): string {
  if (raw == null || raw === '') return '{}'
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw)
    } catch {
      return '{}'
    }
  }
  if (typeof raw !== 'string') {
    try {
      return JSON.stringify(raw)
    } catch {
      return '{}'
    }
  }
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '[object Object]') return '{}'
  if (isValidJsonString(trimmed)) return trimmed
  return repairPartialJson(trimmed) ?? '{}'
}

export function sanitizeAssistantToolCalls<T extends { tool_calls?: unknown }>(msg: T): T {
  if (!Array.isArray(msg.tool_calls)) return msg
  let changed = false
  const next = msg.tool_calls.map((tc) => {
    if (!tc || typeof tc !== 'object') return tc
    const rec = tc as { function?: { arguments?: unknown } }
    const fn = rec.function
    if (!fn || typeof fn !== 'object') return tc
    const coerced = coerceFunctionArguments(fn.arguments)
    if (coerced === fn.arguments) return tc
    changed = true
    return { ...rec, function: { ...fn, arguments: coerced } }
  })
  return changed ? { ...msg, tool_calls: next } : msg
}

/** Chunk de streaming: objecto no último delta vira JSON, nunca "[object Object]". */
export function coerceArgumentChunk(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw)
    } catch {
      return ''
    }
  }
  return String(raw)
}
