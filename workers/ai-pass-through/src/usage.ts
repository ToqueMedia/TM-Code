/**
 * Observação de usage no corpo da resposta — o ÚNICO sítio do data-plane
 * autorizado a olhar para o stream.
 *
 * História: o worker proxy antigo INJETAVA eventos de billing/worker_status
 * no SSE e corrompia o stream — daí os guard-tests "no SSE parser / no
 * TransformStream" no passThrough.test.ts. Este módulo NÃO viola esse
 * contrato no que ele realmente protege: os bytes que saem são EXATAMENTE os
 * bytes que entram (pass-through identity transform); nada é injetado,
 * removido ou reordenado. A observação serve só para extrair o objeto
 * `usage` (prompt/completion tokens) do último chunk e alimentar o commit de
 * billing. O guard-test exclui este ficheiro explicitamente e mantém a
 * proibição para todo o resto do worker.
 *
 * Garantia de usage: `injectStreamOptions` acrescenta
 * `stream_options.include_usage=true` aos pedidos com `stream: true` —
 * OpenAI-compatible providers passam a mandar o usage no chunk final.
 * Fallback (provider que mesmo assim não manda): estimativa grosseira por
 * bytes (request chars/4 para input; bytes de SSE/16 para output — o
 * envelope JSON do SSE é ~4x o conteúdo). Só usado na ausência de usage.
 */

export interface ObservedUsage {
  promptTokens: number
  completionTokens: number
  /** true quando veio do objeto `usage` do provider; false = estimativa. */
  authoritative: boolean
}

export interface UsageObserver {
  /** Corpo a devolver ao cliente — bytes idênticos ao upstream. */
  body: ReadableStream<Uint8Array>
  /** Resolve quando o stream termina (ou em `settle()` num abort). */
  done: Promise<ObservedUsage | null>
  /** Conclui já com o que foi observado — para aborts do cliente. */
  settle: () => void
}

/** Limite do buffer para respostas JSON não-stream (parse do usage). */
const JSON_BUFFER_CAP = 512 * 1024

/**
 * Acrescenta `stream_options: { include_usage: true }` quando o pedido é
 * streaming e o cliente não definiu stream_options próprio. Mantém todos os
 * outros campos intactos.
 */
export function injectStreamOptions(body: Record<string, unknown>): Record<string, unknown> {
  if (body.stream === true && body.stream_options === undefined) {
    return { ...body, stream_options: { include_usage: true } }
  }
  return body
}

function parseUsageObject(value: unknown): ObservedUsage | null {
  const usage = value as { prompt_tokens?: unknown; completion_tokens?: unknown } | null
  if (!usage || typeof usage !== 'object') return null
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  if (prompt <= 0 && completion <= 0) return null
  return { promptTokens: prompt, completionTokens: completion, authoritative: true }
}

/**
 * Envolve o corpo do upstream num identity-transform que observa os bytes.
 *
 * - SSE (`text/event-stream`): faz split por linhas, tenta JSON.parse das
 *   linhas `data:` e guarda o último objeto `usage` não-vazio (providers
 *   OpenAI-compatible mandam-no no chunk final com include_usage).
 * - JSON (não-stream): acumula até JSON_BUFFER_CAP e faz parse no fim.
 * - Sem usage no fim: estimativa por bytes com os chars do request.
 */
export function observeUsage(
  upstreamBody: ReadableStream<Uint8Array>,
  contentType: string | null,
  requestBodyChars: number,
): UsageObserver {
  const isSse = (contentType ?? '').includes('text/event-stream')
  const decoder = new TextDecoder()

  let usage: ObservedUsage | null = null
  let sseLineBuffer = ''
  let jsonBuffer = ''
  let totalBytes = 0
  let settled = false

  let resolveDone: (u: ObservedUsage | null) => void = () => {}
  const done = new Promise<ObservedUsage | null>(resolve => { resolveDone = resolve })

  const finish = (): void => {
    if (settled) return
    settled = true
    if (!usage && !isSse && jsonBuffer) {
      try {
        const parsed = JSON.parse(jsonBuffer) as { usage?: unknown }
        usage = parseUsageObject(parsed.usage)
      } catch { /* corpo não-JSON — segue para a estimativa */ }
    }
    if (!usage && totalBytes > 0) {
      // Estimativa: 4 chars/token no input; no output SSE o envelope JSON é
      // ~4x o conteúdo → ~16 bytes/token. Grosseira mas só corre quando o
      // provider omitiu usage apesar do include_usage.
      usage = {
        promptTokens: Math.ceil(requestBodyChars / 4),
        completionTokens: Math.ceil(totalBytes / (isSse ? 16 : 4)),
        authoritative: false,
      }
    }
    resolveDone(usage)
  }

  const scanSseText = (text: string): void => {
    sseLineBuffer += text
    let newlineIdx = sseLineBuffer.indexOf('\n')
    while (newlineIdx !== -1) {
      const line = sseLineBuffer.slice(0, newlineIdx).replace(/\r$/, '')
      sseLineBuffer = sseLineBuffer.slice(newlineIdx + 1)
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim()
        // Parse apenas quando a linha pode conter usage — evita JSON.parse
        // de cada delta de texto num stream longo.
        if (payload && payload !== '[DONE]' && payload.includes('"usage"')) {
          try {
            const parsed = JSON.parse(payload) as { usage?: unknown }
            const found = parseUsageObject(parsed.usage)
            if (found) usage = found
          } catch { /* chunk parcial/não-JSON — ignora */ }
        }
      }
      newlineIdx = sseLineBuffer.indexOf('\n')
    }
  }

  // `cancel` faz parte do Streams spec moderno (suportado pelo runtime dos
  // Workers e por Node 20+), mas a lib DOM do TypeScript desta versão ainda
  // não o declara em Transformer — daí a interseção explícita.
  const transformer: Transformer<Uint8Array, Uint8Array> & { cancel?: () => void } = {
    transform(chunk, controller) {
      // Identity primeiro — o cliente recebe os bytes tal e qual, mesmo que
      // a observação abaixo falhe por qualquer razão.
      controller.enqueue(chunk)
      try {
        totalBytes += chunk.byteLength
        const text = decoder.decode(chunk, { stream: true })
        if (isSse) {
          scanSseText(text)
        } else if (jsonBuffer.length < JSON_BUFFER_CAP) {
          jsonBuffer += text
        }
      } catch { /* observação é best-effort */ }
    },
    flush() {
      try {
        const tail = decoder.decode()
        if (isSse && tail) scanSseText(tail + '\n')
        else if (!isSse && tail && jsonBuffer.length < JSON_BUFFER_CAP) jsonBuffer += tail
      } catch { /* best-effort */ }
      finish()
    },
    // Cliente desligou a meio do stream (cancel propaga do readable):
    // liquida com o que foi observado até aqui. Sem isto, `done` nunca
    // resolvia nesses casos e o commit ficava pendurado no waitUntil até o
    // runtime o cancelar — "waitUntil() tasks did not complete within the
    // allowed time" nos logs e tokens consumidos NÃO cobrados.
    cancel() {
      finish()
    },
  }
  const transform = new TransformStream<Uint8Array, Uint8Array>(transformer)

  return {
    body: upstreamBody.pipeThrough(transform),
    done,
    settle: finish,
  }
}
