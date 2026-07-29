function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Remove blocos de raciocínio embebidos INLINE no texto da resposta.
 *
 * Modelos não-streaming metem `<think>…</think>` (ou `<thought>`) dentro do
 * `message.content` em vez de o separarem em `reasoning_content`. Este strip
 * existia só no gerador de mensagens de commit (auditoria 2026-07-28), portanto
 * todas as outras one-shots — melhoria de prompt, autocompletar, e sobretudo os
 * SUMÁRIOS DE COMPACTAÇÃO — podiam levar raciocínio cru para a UI ou, pior,
 * de volta para o histórico do modelo. Os modelos de sidecar vêm da config KV e
 * não são conhecidos à partida, por isso o strip tem de ser incondicional.
 *
 * Fecho não emparelhado é tratado: com um `</think>` sem abertura, tudo o que
 * vem antes dele é raciocínio.
 */
export function stripInlineReasoning(text: string): string {
  let out = text.replace(/<(think|thought)>[\s\S]*?<\/\1>/gi, '')
  const lastClose = Math.max(
    out.toLowerCase().lastIndexOf('</think>'),
    out.toLowerCase().lastIndexOf('</thought>'),
  )
  if (lastClose !== -1) {
    const closeTag = out.toLowerCase().lastIndexOf('</thought>') === lastClose ? '</thought>' : '</think>'
    out = out.slice(lastClose + closeTag.length)
  }
  return out.replace(/<\/?(think|thought)>/gi, '').trim()
}

function textFromValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(textFromValue).filter(Boolean).join('')
  }
  if (!isRecord(value)) return ''

  const direct =
    textFromValue(value.text) ||
    textFromValue(value.output_text) ||
    textFromValue(value.value) ||
    textFromValue(value.content)
  return direct
}

function textFromMessage(value: unknown): string {
  if (!isRecord(value)) return ''
  return (
    textFromValue(value.content) ||
    textFromValue(value.text) ||
    textFromValue(value.output_text) ||
    textFromValue(value.reasoning_content)
  )
}

function textFromResponsesOutput(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const text =
      textFromValue(item.content) ||
      textFromValue(item.text) ||
      textFromValue(item.output_text)
    if (text) parts.push(text)
  }
  return parts.join('')
}

/**
 * Extract assistant text from OpenAI-compatible Chat Completions and common
 * Responses-style envelopes. Some BYOK gateways return content as arrays or
 * top-level output_text; treating only `choices[0].message.content` as valid
 * makes successful 200 responses look empty to auxiliary callers.
 */
export function extractAssistantTextFromCompletion(value: unknown): string {
  if (!isRecord(value)) return ''

  const choices = value.choices
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      const text =
        textFromMessage(choice.message) ||
        textFromMessage(choice.delta) ||
        textFromValue(choice.text)
      if (text.trim()) return stripInlineReasoning(text)
    }
  }

  const topLevel =
    textFromValue(value.output_text) ||
    textFromValue(value.text) ||
    textFromValue(value.content) ||
    textFromResponsesOutput(value.output)
  return stripInlineReasoning(topLevel)
}
