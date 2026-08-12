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
  /**
   * Tokens de prompt servidos a partir do cache do provider (subconjunto de
   * promptTokens — o provider já os inclui no total). Faturados a preço
   * reduzido (ver CACHE_BILLING_FACTOR): num loop agentico o prefixo em cache
   * é a maioria de cada turno, por isso descontá-lo estica muito a quota.
   */
  cachedTokens: number
  /**
   * Geração de imagens: custo REAL em USD (input de referência × preço de
   * input + imagens geradas × preço do escalão reportado). Presente SÓ no
   * ramo de imagens — aí o billing debita este valor directamente em µ$
   * (metering 30/70) em vez de precificar tokens.
   */
  imageCostUsd?: number
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

/**
 * Rate card OFICIAL do qwen-image-3.0-pro, em USD por imagem (fornecido pelo
 * developer a partir da consola Model Studio, 2026-08-08). Guardado verbatim
 * para ser auditável contra a fonte — a conversão a tokens é separada.
 *
 * O escalão NÃO se escolhe NEM se prevê a partir do pedido: vem na resposta,
 * em `output_image_type` (`qima_output_1k` / `qima_output_2k`). Seis sondagens
 * a 2026-08-08 provaram-no — o MESMO pedido (1664*928, n=1, seed 42, prompt
 * idêntico) devolveu 2k a 2752*1536 numa altura e 1k a 1664*928 noutra. É por
 * isso que este ficheiro lê o escalão reportado em vez de o inferir do corpo
 * do pedido: inferi-lo daria a factura errada em metade dos casos.
 * `input` cobre cada imagem de REFERÊNCIA enviada num pedido de edição (I2I).
 */
export const IMAGE_PRICE_USD = {
  output1k: 0.04,
  output2k: 0.075,
  input: 0.003,
} as const

/**
 * Âncora de conversão USD → tokens: o orçamento deste produto conta-se em
 * TOKENS, portanto uma imagem tem de ser traduzida para essa moeda. Este é o
 * preço por milhão de tokens de SAÍDA do modelo de texto de referência.
 *
 * ⚠️ É o único número aqui que não vem de um rate card verificado — é a taxa
 * de câmbio interna do produto. Está isolado numa constante de propósito:
 * corrigi-lo é uma edição, e toda a aritmética de imagem acompanha.
 */
export const USD_PER_MILLION_TOKENS = 2.2

/** USD → tokens-equivalentes. Arredonda para CIMA: nunca cobrar a menos. */
export function imageUsdToTokens(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0
  return Math.ceil((usd / USD_PER_MILLION_TOKENS) * 1_000_000)
}

/** Preços por imagem (USD) que a config pode sobrepor ao rate card acima. */
export interface ImagePricing {
  output1k?: number
  output2k?: number
  input?: number
}

function parseUsageObject(value: unknown, imagePricing: ImagePricing | undefined): ObservedUsage | null {
  const usage = value as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    cached_tokens?: unknown
    cache_read_input_tokens?: unknown
    prompt_tokens_details?: { cached_tokens?: unknown } | null
    output_image_count?: unknown
    output_image_type?: unknown
    input_image_count?: unknown
  } | null
  if (!usage || typeof usage !== 'object') return null
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0

  // Geração de imagens (DashScope qwen-image): o `usage` não tem tokens
  // NENHUNS — traz contagem, escalão e dimensões das imagens. Este ramo tem de
  // vir ANTES do guard `prompt<=0 && completion<=0`, senão devolvia null, o
  // observador caía na estimativa por bytes e uma imagem custava o peso do seu
  // JSON de resposta (~150 tokens por algo que custa 3 a 7 cêntimos reais).
  //
  // Cobra-se pelo que o provider DIZ que produziu, ao preço do escalão que ele
  // próprio reporta — e as imagens de referência de uma edição (I2I) entram
  // como input. Tudo em tokens-equivalentes, para reusar o pipeline a jusante
  // sem lhe tocar: multiplicador da persona, overage e fatia de equipa.
  const outCount = typeof usage.output_image_count === 'number' ? usage.output_image_count : 0
  const inCount = typeof usage.input_image_count === 'number' ? usage.input_image_count : 0
  if (prompt <= 0 && completion <= 0 && outCount > 0) {
    // Escalão desconhecido → assume-se o CARO. Um `output_image_type` que a
    // Alibaba renomeie não pode virar desconto silencioso.
    const is1k = usage.output_image_type === 'qima_output_1k'
    const outUsd = is1k
      ? (imagePricing?.output1k ?? IMAGE_PRICE_USD.output1k)
      : (imagePricing?.output2k ?? IMAGE_PRICE_USD.output2k)
    const inUsd = imagePricing?.input ?? IMAGE_PRICE_USD.input
    return {
      // Imagens de referência = input; imagens geradas = output. Mantém a
      // separação em tokens-equivalentes para logs/estimativas antigas.
      promptTokens: imageUsdToTokens(inCount * inUsd),
      completionTokens: imageUsdToTokens(outCount * outUsd),
      cachedTokens: 0,
      // Metering 30/70: o billing debita o custo REAL em µ$ — a conversão
      // para tokens acima fica só para observabilidade.
      imageCostUsd: inCount * inUsd + outCount * outUsd,
      // authoritative: contagem e escalão vieram do provider. Não é um
      // palpite sobre bytes — é o que ele diz que gerou.
      authoritative: true,
    }
  }

  if (prompt <= 0 && completion <= 0) return null
  // cached_tokens vive em prompt_tokens_details.cached_tokens (OpenAI-compat /
  // DashScope) ou cache_read_input_tokens (Anthropic). É um subconjunto de
  // prompt_tokens. Clampado a [0, prompt] por segurança.
  const details = usage.prompt_tokens_details
  const cachedRaw =
    (details && typeof details.cached_tokens === 'number' ? details.cached_tokens : 0) ||
    (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0) ||
    (typeof usage.cached_tokens === 'number' ? usage.cached_tokens : 0)
  const cached = Math.max(0, Math.min(prompt, cachedRaw))
  return { promptTokens: prompt, completionTokens: completion, cachedTokens: cached, authoritative: true }
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
  /** Preços por imagem (USD) da config — só usados quando a resposta é de
   *  geração de imagens. Ausente → o rate card oficial em IMAGE_PRICE_USD. */
  imagePricing?: ImagePricing,
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
        usage = parseUsageObject(parsed.usage, imagePricing)
      } catch { /* corpo não-JSON — segue para a estimativa */ }
    }
    if (!usage && totalBytes > 0) {
      // Estimativa: 4 chars/token no input; no output SSE o envelope JSON é
      // ~4x o conteúdo → ~16 bytes/token. Grosseira mas só corre quando o
      // provider omitiu usage apesar do include_usage.
      usage = {
        promptTokens: Math.ceil(requestBodyChars / 4),
        completionTokens: Math.ceil(totalBytes / (isSse ? 16 : 4)),
        // A estimativa não sabe quanto foi cache — assume 0 (sem desconto).
        cachedTokens: 0,
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
            const found = parseUsageObject(parsed.usage, imagePricing)
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
