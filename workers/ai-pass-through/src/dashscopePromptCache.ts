export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__TM_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

const EXPLICIT_CACHE_MIN_STATIC_BYTES = 4096

/**
 * Mínimo de conteúdo (em bytes) no histórico antes de valer a pena marcar a
 * última mensagem. O Model Studio exige 1024 tokens por bloco explícito; abaixo
 * disso o marcador é ignorado, e criar cache custa 125% do input — um marcador
 * ignorado é premium pago a troco de nada.
 */
const EXPLICIT_CACHE_MIN_HISTORY_BYTES = 4096

/** Máximo de marcadores por pedido (se houver mais, valem os últimos 4). */
const MAX_CACHE_MARKERS = 4

/**
 * Manter alinhado com o gémeo do IDE (src/services/agent/dashscopePromptCache.ts).
 *
 * Os Kimi ficam na lista por inércia: o developer confirmou (2026-08-10) que
 * NÃO servimos Kimi via DashScope, portanto estas entradas nunca são
 * consultadas. Ficam porque removê-las não ganha nada e voltar a adicioná-las
 * um dia sem o contexto acima ganha um bug.
 */
const DASHSCOPE_EXPLICIT_CACHE_MODELS = new Set([
  'qwen3.8-max',
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

export interface DashScopePromptCacheStats {
  found: boolean
  /** False means the request still uses DashScope's automatic implicit cache;
   *  we only stripped TM Code's internal boundary marker. */
  cacheControlApplied: boolean
  staticBytes: number
  dynamicBytes: number
  /** Marcador rolante na última mensagem — sem ele o cache congela no system. */
  rollingMarkerApplied: boolean
  historyBytes: number
}

function isDashScopeProvider(provider: string | undefined, baseUrl: string | undefined): boolean {
  if (provider === 'dashscope') return true
  if (!baseUrl) return false
  try {
    return /(^|\.)dashscope(-[a-z0-9]+)?\.aliyuncs\.com$/i.test(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

/**
 * FAMÍLIA, não versão exacta (2026-07-29). Ver a nota gémea no IDE
 * (src/services/agent/dashscopePromptCache.ts): trocar o modelo gerido é uma
 * edição de dados no KV, e o `model !== 'glm-5.1'` deixou de bater quando o
 * activo passou a `glm-5.2` — sem marcadores, o prefixo cacheado congela e o
 * histórico é refacturado todos os turnos (12,36M de input numa só sessão).
 * A correcção estrutural é a capacidade vir do KV `active`.
 */
function supportsExplicitCache(model: string, _baseUrl: string | undefined): boolean {
  if (DASHSCOPE_EXPLICIT_CACHE_MODELS.has(model)) return true
  // Família GLM — ramo VIVO (corrigido 2026-08-10 pelo developer).
  //
  // O mesmo `glm-5.2` é servido por DOIS provedores em simultâneo — z.AI e
  // DashScope — e um terceiro (Cloudflare Workers AI) está a caminho. Este
  // ramo trata o caso DashScope; o z.AI nem chega aqui (isDashScopeProvider
  // corta a montante). Kimi via DashScope é que não existe.
  //
  // Saiu o gate de REGIÃO que tinha
  // (`host === 'dashscope.aliyuncs.com' || host.includes('cn-beijing')`). Esse
  // gate é a terceira encarnação do mesmo defeito: prender a capacidade a um
  // literal que muda por DADOS. Primeiro foi a versão (`model !== 'glm-5.1'`,
  // partiu quando o activo passou a glm-5.2); depois a região — e se o GLM
  // voltasse pelo DashScope em US ou Singapura, teria falhado calado outra vez.
  //
  // `isDashScopeProvider` já garante, a montante, que só chegamos aqui em hosts
  // DashScope. A correcção estrutural continua a ser a capacidade vir do KV
  // `active`, como o resto do routing.
  return /^glm-/i.test(model)
}

/**
 * Marcador rolante na ÚLTIMA mensagem — cache incremental do histórico.
 *
 * PORQUE FALTAVA AQUI (2026-08-10)
 * ────────────────────────────────
 * O gémeo do IDE (src/services/agent/dashscopePromptCache.ts) recebeu isto a
 * 2026-07-31, mas só serve o caminho BYOK. O caminho GERIDO passa por este
 * worker, que ficou na versão anterior: marcava só o bloco de system, portanto
 * o prefixo cacheado congelava aí e TODO o histórico era refacturado a preço
 * cheio a cada turno. É a maioria dos utilizadores — os que não têm BYOK.
 *
 * Medido na sessão golive (2026-08-10, qwen3.7-plus, persona standard):
 * `cacheReadInputTokens` parado em 25.111 nos 43 pedidos com cache de uma
 * sessão inteira, enquanto o input crescia de 30.726 para 98.311. 2,68M tokens
 * de input com 40% de cache-read; no último pedido 74% do input era novo.
 * Mesmo sintoma que a sessão katondo-queue já tinha mostrado no lado do IDE.
 *
 * CONTRATO (Model Studio, "Context Cache" + "Explicit Cache Best Practices",
 * reconferido a 2026-08-10):
 *   · máximo 4 marcadores por pedido — usamos 2 (system + última mensagem);
 *   · o bloco cacheado tem de ter ≥1024 tokens;
 *   · TTL de 5 minutos, RENOVADO a cada hit (num loop de agente os turnos
 *     estão a segundos, portanto o bloco mantém-se vivo);
 *   · criar custa 125% do input, ler custa 10%;
 *   · o padrão recomendado para multi-turno é exactamente este: um marcador
 *     rolante na mensagem mais recente, que lê o bloco do turno anterior e
 *     escreve só o delta;
 *   · dentro de uma mensagem só o ÚLTIMO marcador conta — daí marcarmos o
 *     último bloco de texto.
 *
 * LIMITE A VIGIAR: a procura de hit anda para trás no máximo **20 content
 * blocks** a partir do marcador. Entre dois turnos consecutivos o marcador
 * anda 2-4 blocos (assistant + tool results), logo há folga larga. Um turno
 * que despeje mais de 20 blocos de uma vez (paralelismo extremo de tool calls)
 * perde o hit e paga 125% a criar de novo — não é uma regressão face a não
 * marcar, mas é o cenário onde este mecanismo deixa de render.
 *
 * Devolve true se marcou.
 */
function markLastMessageForCache(messages: Array<Record<string, unknown>>): boolean {
  // Da última para trás: uma mensagem de assistant que só traga `tool_calls`
  // tem content nulo e não pode carregar o marcador.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'system') break // chegámos ao prefixo estático: nada a marcar

    if (typeof msg.content === 'string' && msg.content.length > 0) {
      msg.content = [
        { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } },
      ]
      return true
    }

    if (Array.isArray(msg.content)) {
      const parts = msg.content as Array<Record<string, unknown>>
      // O marcador vai num bloco de TEXTO. Blocos de imagem não o carregam, e
      // marcar o último bloco às cegas podia cair num deles.
      for (let p = parts.length - 1; p >= 0; p--) {
        const part = parts[p]
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          part.cache_control = { type: 'ephemeral' }
          return true
        }
      }
    }
  }
  return false
}

/** Conteúdo fora do system: é o que o segundo bloco vai cobrir. */
function historyBytesOf(messages: Array<Record<string, unknown>>): number {
  let bytes = 0
  for (const msg of messages) {
    if (msg.role === 'system') continue
    bytes += typeof msg.content === 'string'
      ? msg.content.length
      : JSON.stringify(msg.content ?? '').length
  }
  return bytes
}

/** Quantos marcadores existem já no corpo — o limite é por PEDIDO, não por mensagem. */
function countCacheMarkers(messages: Array<Record<string, unknown>>): number {
  let n = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<Record<string, unknown>>) {
      if (part && typeof part === 'object' && 'cache_control' in part) n++
    }
  }
  return n
}

export function applyDashScopePromptCache(
  body: Record<string, unknown>,
  opts: { provider?: string; baseUrl?: string; model?: string; requestType?: string | null },
): DashScopePromptCacheStats {
  const zero: DashScopePromptCacheStats = {
    found: false,
    cacheControlApplied: false,
    staticBytes: 0,
    dynamicBytes: 0,
    rollingMarkerApplied: false,
    historyBytes: 0,
  }
  if (!isDashScopeProvider(opts.provider, opts.baseUrl)) return zero
  // Só corpos de CHAT. O sidecar `image` fala a API NATIVA da DashScope (a
  // geração de imagens não existe no modo OpenAI-compatible — 404 verificado
  // ao vivo 2026-08-08, ver activeConfig.ts), e o marcador rolante converte o
  // `content` da última mensagem num array de blocos com `cache_control` —
  // uma forma que essa API não conhece. Defeito introduzido com o marcador
  // rolante (2026-08-10): antes só se tocava no bloco de system.
  if ((opts.requestType ?? '').trim().toLowerCase() === 'image') return zero
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, unknown>>)
    : null
  if (!messages) return zero

  const model = opts.model || (typeof body.model === 'string' ? body.model : '')
  const canCache = supportsExplicitCache(model, opts.baseUrl)
  let first = zero

  for (const msg of messages) {
    if (msg.role !== 'system' || typeof msg.content !== 'string') continue
    const content = msg.content
    const idx = content.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    if (idx === -1) {
      // Post-FASE-B (auditoria 2026-07-28): the IDE splits the prompt at BUILD
      // time and the volatile block travels in the user message, so the marker
      // stopped arriving here — "no marker" now means the system message IS the
      // byte-stable prefix. Until this branch existed the `continue` below made
      // explicit caching dead for every DashScope-routed managed model.
      if (!canCache || content.length < EXPLICIT_CACHE_MIN_STATIC_BYTES) continue
      msg.content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
      if (!first.found) {
        first = {
          ...zero,
          found: true,
          cacheControlApplied: true,
          staticBytes: content.length,
          dynamicBytes: 0,
        }
      }
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

    if (!first.found) {
      first = {
        ...zero,
        found: true,
        cacheControlApplied: applyCache,
        staticBytes: before.length,
        dynamicBytes: after.length,
      }
    }
  }

  // Segundo marcador: a última mensagem, para o histórico entrar no cache em
  // vez de ser refacturado a preço cheio a cada turno. Sem isto o cache-read
  // congela no valor do bloco de system e nunca mais se mexe.
  const historyBytes = historyBytesOf(messages)
  let rollingMarkerApplied = false
  if (
    canCache &&
    historyBytes >= EXPLICIT_CACHE_MIN_HISTORY_BYTES &&
    countCacheMarkers(messages) < MAX_CACHE_MARKERS
  ) {
    rollingMarkerApplied = markLastMessageForCache(messages)
  }

  return { ...first, rollingMarkerApplied, historyBytes }
}
