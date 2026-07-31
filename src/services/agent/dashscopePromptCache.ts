export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__TM_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

const EXPLICIT_CACHE_MIN_STATIC_BYTES = 4096

/**
 * Mínimo de conteúdo (em bytes) no histórico antes de valer a pena marcar a
 * última mensagem.
 *
 * A documentação do Model Studio exige 1024 tokens para um bloco de cache
 * explícito; abaixo disso o marcador é ignorado. Como criar cache custa 125% do
 * preço de input e ler custa 10%, um marcador ignorado é premium pago a troco de
 * nada. 4096 bytes é o mesmo limiar conservador que já se aplica ao bloco
 * estático (~1024+ tokens em qualquer tokenizador razoável).
 */
const EXPLICIT_CACHE_MIN_HISTORY_BYTES = 4096

/**
 * Um pedido aceita no máximo 4 marcadores (os últimos 4 ganham, se houver mais).
 * Usamos 2: o bloco estático do system e a última mensagem. A folga é
 * deliberada — deixa espaço para um marcador nas tool definitions no futuro sem
 * ter de repensar a contagem.
 */
const MAX_CACHE_MARKERS = 4

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

/**
 * FAMÍLIA, não versão exacta (2026-07-29).
 *
 * Era `model !== 'glm-5.1'`. Trocar o modelo gerido é uma edição de DADOS no
 * KV, não de código — foi assim que o activo passou a `glm-5.2` e esta
 * igualdade deixou de bater, silenciosamente. Sem marcadores de cache, o
 * prefixo cacheado congela no bloco estático e todo o histórico é refacturado
 * a cada turno: sessão katondo-queue (29-07) fechou com 12,36M tokens de input
 * e 36% de cache, com o valor cacheado parado em 31.808 desde o turno 11.
 *
 * O gate de host fica — é ele que garante que só se marca onde o provider
 * suporta. O que sai é o acoplamento a um número de versão.
 *
 * A correcção estrutural é a capacidade vir do próprio KV `active` (como o
 * resto do routing), em vez de qualquer lista em código. Enquanto isso não
 * existir, uma família não obriga a um commit por ponto de versão.
 */
function supportsExplicitCache(model: string, baseURL: string | undefined): boolean {
  if (DASHSCOPE_EXPLICIT_CACHE_MODELS.has(model)) return true
  if (!/^glm-/i.test(model) || !baseURL) return false
  const host = baseURL.toLowerCase()
  return host === 'dashscope.aliyuncs.com' || host.includes('cn-beijing')
}

/**
 * Marcador rolante na ÚLTIMA mensagem — cache incremental do histórico.
 *
 * PORQUE ISTO FALTAVA (2026-07-31)
 * ────────────────────────────────
 * Só se marcava o bloco de system. Consequência: o prefixo cacheado congelava
 * aí e TODO o histórico era refaturado a preço cheio a cada turno — que é
 * exatamente o que a sessão katondo-queue mostrou (12,36M tokens de input, valor
 * cacheado parado nos 31.808 desde o turno 11). O caminho Anthropic
 * (anthropicAdapter) já fazia isto; o DashScope não, e eu tinha-o dado como
 * "não verificável sem testar contra a API".
 *
 * A documentação oficial responde e desmente essa cautela — Model Studio,
 * "Context Cache" e "显式缓存最佳实践":
 *   · o marcador é aceite em mensagens `system`, `user`, `assistant` E `tool`,
 *     não só no system;
 *   · máximo 4 marcadores por pedido (se houver mais, valem os últimos 4);
 *   · mínimo 1024 tokens por bloco;
 *   · e a recomendação para multi-turno é literalmente marcar o ÚLTIMO objecto
 *     de conteúdo de cada turno, para o turno seguinte ler o bloco anterior e
 *     escrever só o delta.
 *
 * Custo: criar cache é 125% do input, ler é 10%, e o bloco vive 5 minutos. Num
 * loop de agente os turnos estão a segundos uns dos outros, portanto o delta
 * escrito por turno é pequeno e o prefixo inteiro passa a ler-se a 10%. Numa
 * conversa com pausas longas o bloco expira — mas esse risco já existia para o
 * marcador do system e o padrão continua a ser o recomendado.
 *
 * Devolve true se marcou.
 */
function markLastMessageForCache(
  messages: Array<Record<string, unknown>>,
): boolean {
  // Quanto conteúdo existe fora do system: é o que o segundo bloco vai cobrir.
  let historyBytes = 0
  for (const msg of messages) {
    if (msg.role === 'system') continue
    historyBytes += typeof msg.content === 'string'
      ? msg.content.length
      : JSON.stringify(msg.content ?? '').length
  }
  if (historyBytes < EXPLICIT_CACHE_MIN_HISTORY_BYTES) return false

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

  // Segundo marcador: a última mensagem, para o histórico entrar no cache em vez
  // de ser refaturado a preço cheio a cada turno. Só quando o modelo suporta
  // cache explícito — noutros casos o campo seria ruído no corpo.
  if (canCache && countCacheMarkers(messages) < MAX_CACHE_MARKERS) {
    if (markLastMessageForCache(messages)) changed = true
  }

  return changed
}
