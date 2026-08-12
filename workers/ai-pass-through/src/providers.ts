/**
 * Identificação de provedor — partilhada, para não nascerem cópias.
 *
 * `isCloudflareAI` vivia dentro de `applyReasoningEffort.ts`. Passou para aqui
 * quando o segundo consumidor apareceu (a afinidade de sessão em `index.ts`):
 * duplicá-lo era exactamente o padrão que já produziu três defeitos nesta base
 * de código — dois detectores gémeos e a correcção a chegar só a um. Os
 * restantes detectores de família seguiram o mesmo caminho quando o pricing
 * por modelo+provider (pricing.ts, metering 30/70) precisou deles — mesma
 * regra: detectar por PROVIDER/HOST, nunca só pelo nome do modelo.
 */

export interface ProviderIdentity {
  provider?: string
  baseUrl?: string
  model?: string
}

const lower = (v: string | undefined): string => (v ?? '').trim().toLowerCase()

/**
 * Id de modelo SEM o prefixo de autor. O Cloudflare AI Gateway usa a sintaxe
 * `author/model` (`xai/grok-4.5`) e o Workers AI `@cf/author/model`
 * (`@cf/zai-org/glm-5.2`) — em ambos o que interessa ao pricing/effort é o
 * nome nu. Corte no ÚLTIMO `/` para não partir ids com autor.
 */
export function bareModel(model: string | undefined): string {
  const m = lower(model)
  const slash = m.lastIndexOf('/')
  return slash >= 0 ? m.slice(slash + 1) : m
}

export function isDashScope(ctx: ProviderIdentity): boolean {
  const p = lower(ctx.provider)
  const b = lower(ctx.baseUrl)
  return (
    p === 'dashscope' ||
    p === 'aliyun' ||
    b.includes('dashscope') ||
    b.includes('aliyuncs.com') ||
    b.includes('maas.aliyuncs.com')
  )
}

export function isZAI(ctx: ProviderIdentity): boolean {
  const p = lower(ctx.provider)
  const b = lower(ctx.baseUrl)
  return (
    p === 'zai' ||
    p === 'z.ai' ||
    p === 'zhipu' ||
    p === 'bigmodel' ||
    b.includes('z.ai') ||
    b.includes('bigmodel.cn') ||
    b.includes('open.bigmodel')
  )
}

export function isXAI(ctx: ProviderIdentity): boolean {
  const p = lower(ctx.provider)
  const b = lower(ctx.baseUrl)
  return (
    p === 'xai' ||
    p === 'x.ai' ||
    b.includes('api.x.ai') ||
    lower(ctx.model).startsWith('xai/') ||
    // Nome nu a começar em `grok` só chega como último recurso: a família é
    // da x.AI (o Grok não é servido por mais nenhum provider no catálogo).
    bareModel(ctx.model).startsWith('grok-')
  )
}

export function isMoonshot(ctx: ProviderIdentity): boolean {
  const p = lower(ctx.provider)
  const b = lower(ctx.baseUrl)
  const m = bareModel(ctx.model)
  // provider pode ser `moonshot`, `moonshotai`, `kimi`, … — e via Cloudflare
  // AI Gateway o provider é `cloudflare` e o modelo `moonshotai/kimi-k3`
  // (bareModel + o prefixo de autor no id cobrem esse caso).
  return (
    p.includes('moonshot') ||
    p.includes('kimi') ||
    b.includes('moonshot') ||
    b.includes('kimi.ai') ||
    lower(ctx.model).startsWith('moonshotai/') ||
    m.startsWith('kimi-k3') ||
    m.startsWith('kimi-k2')
  )
}

/**
 * Cloudflare Workers AI — TERCEIRO provedor do mesmo glm-5.2 (2026-08-10).
 *
 * Detecta por PROVIDER/HOST e nunca pelo nome do modelo: o id do Workers AI é
 * `@cf/zai-org/glm-5.2` e contém `zai-org`, que é precisamente a coincidência
 * capaz de fazer um detector por nome mandar parâmetros do z.AI para um host
 * da Cloudflare. (O mesmo colapso aconteceu no IDE, no selector de effort:
 * `normalizeEffortModelId` cortava no último `/` e a UI oferecia `max`.)
 */
export function isCloudflareAI(ctx: ProviderIdentity): boolean {
  const p = lower(ctx.provider)
  const b = lower(ctx.baseUrl)
  return (
    p === 'cloudflare' ||
    p === 'workers-ai' ||
    p === 'workersai' ||
    b.includes('api.cloudflare.com') ||
    b.includes('.workers.dev') ||
    lower(ctx.model).startsWith('@cf/')
  )
}

/** FNV-1a 32-bit → hex. Barato, síncrono, determinístico. */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Header de afinidade do Workers AI. */
export const SESSION_AFFINITY_HEADER = 'x-session-affinity'

/**
 * Header de afinidade da x.AI (prompt caching do Grok, docs.x.ai →
 * advanced-api-usage/prompt-caching): o cache é AUTOMÁTICO mas por prefixo
 * exacto e com evicção; a doc recomenda um id estável de conversa para
 * routing sticky ao mesmo servidor. Sem isto cada pedido pode aterrar num
 * servidor frio e pagar $2/M em vez de $0,30/M no prefixo inteiro.
 */
export const XAI_CONV_ID_HEADER = 'x-grok-conv-id'

/**
 * Afinidade de sessão para o prefix cache do Workers AI.
 *
 * ⚠️ MEDIDO A 2026-08-12: NO ENDPOINT OpenAI-COMPATIBLE, ISTO NÃO FAZ NADA.
 * ─────────────────────────────────────────────────────────────────────────
 * Sonda directa ao Workers AI (`@cf/zai-org/glm-5.2`, prefixo estável de 35K
 * tokens, braços INTERCALADOS e com prefixo próprio para não se aquecerem um
 * ao outro):
 *
 *     com header, chave estável ......... 16/26 hits (61,5%)
 *     sem header OU chave aleatória ..... 15/26 hits (57,7%)
 *
 * O teste decisivo é o segundo: uma chave ALEATÓRIA por pedido devia espalhar
 * os pedidos por instâncias e levar o cache a ~0. Deu 8/14 — indistinguível da
 * chave constante (9/14). **O header está a ser ignorado.** Bate certo com a
 * doc, que só documenta o mecanismo para REST e binding e nunca para
 * `/v1/chat/completions` (a "INCÓGNITA" que a versão anterior deste comentário
 * assumia como aposta barata: a aposta perdeu-se).
 *
 * O 25,2% → 54,6% que se atribuiu a este header NÃO foi causado por ele. A
 * taxa base num ciclo apertado é ~58-64% haja header ou não; o que mexe é a
 * forma da sessão (histórico a crescer, pausas, runs em competição), não a
 * chave. As "medições" de 1/5/9 runs abaixo descrevem isso, não a afinidade.
 *
 * MANTIDO mesmo assim: um header ignorado é inócuo, e o mecanismo pode ser
 * real no caminho REST/binding se algum dia formos por lá. NÃO contar com ele
 * para orçamentar margem — ver docs/HANDOFF-CACHE-E-DEFERRAL.md §3.
 *
 * O QUE MOTIVOU (2026-08-10, sessão GLM-5.2/Cloudflare) — diagnóstico do
 * sintoma, que se mantém válido; a CAUSA atribuída é que não.
 * ──────────────────────────────────────────────
 * Medido: 3,9M tokens de input com apenas **25,2%** de cache-read, contra
 * 94,7% do qwen/DashScope. E o nosso lado estava limpo — `promptPrefixHash`
 * IDÊNTICO nos 35 pedidos, prefixo de mensagens nunca reescrito (só no
 * pós-compactação). Quando acertava, acertava 93-100% do prefixo inteiro;
 * quando falhava, era zero. Binário, e sem correlação com o tempo (hits com
 * mediana de 13,5s de intervalo, misses 14,6s; um hit aos 91s, misses aos
 * 3,4s). Ou seja: não é TTL nem prefixo instável — é o pedido a aterrar ora
 * numa instância quente, ora numa fria. 9 acertos em 34 ≈ roteamento aleatório.
 *
 * A doc é explícita (developers.cloudflare.com/workers-ai/features/prompt-caching):
 *   "prefix caching only works when a request routes to the same model
 *    instance that holds the cached tensors"
 * e dá o mecanismo: enviar `x-session-affinity` com um identificador estável,
 * que encaminha os pedidos com o mesmo id para a mesma instância.
 *
 * GRANULARIDADE: por SESSÃO, com o uid como recurso (2026-08-11).
 *
 * Começou por utilizador — resolveu em parte (25,2% → 54,6% numa sessão de um
 * só run) mas degrada com o número de runs, porque todos partilham a chave e
 * despejam o prefixo uns dos outros da MESMA instância. Medido, com o prefixo
 * byte-estável em todas (um só promptPrefixHash por sessão):
 *     1 run → 54,6%     5 runs → 36,2%     9 runs → 33,6%
 * A correlação é monótona com o número de runs, não com o tamanho da sessão.
 *
 * O IDE passa a mandar `x-tm-session-id`; cada run ganha a sua instância e o
 * seu prefixo. Sem o header (builds antigas), cai no uid — o comportamento
 * anterior, que é melhor que nenhuma afinidade.
 *
 * O valor vai HASHED: o uid é um identificador de conta e não há motivo para o
 * mandar em claro num header upstream quando um token opaco e estável serve o
 * mesmo fim.
 *
 * As duas INCÓGNITAS que aqui estavam foram fechadas a 2026-08-12, e uma delas
 * mal (ver o aviso no topo):
 *  1. o header é respeitado no endpoint OpenAI-compatible? **NÃO.**
 *  2. qual é o desconto dos cached tokens? **$0,26/M contra $1,40/M de input**
 *     (página do modelo) — é o que `pricing.ts` já tem.
 */
export const SESSION_ID_HEADER = 'x-tm-session-id'

/**
 * Afinidade de sessão por provider. Devolve o valor aplicado (para logs) ou
 * null quando o provider não tem mecanismo de afinidade. Mesma granularidade
 * nos dois: SESSÃO primeiro, uid como recurso para builds antigas.
 */
export function applySessionAffinity(
  headers: Headers,
  identity: ProviderIdentity,
  userId: string | null | undefined,
  sessionId?: string | null,
): string | null {
  const isCf = isCloudflareAI(identity)
  const isXai = !isCf && isXAI(identity)
  if (!isCf && !isXai) return null
  // Sessão primeiro; uid como recurso para builds que ainda não mandam o header.
  const seed = (sessionId ?? '').trim() || (userId ?? '').trim()
  if (!seed) return null
  const value = `tm_${fnv1aHex(seed)}`
  // `set` e não `append`: o header do cliente, se existir, não manda aqui.
  headers.set(isCf ? SESSION_AFFINITY_HEADER : XAI_CONV_ID_HEADER, value)
  return value
}
