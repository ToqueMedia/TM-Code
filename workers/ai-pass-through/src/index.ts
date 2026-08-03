import { getConfigForRequest, getTeamByokConfig, buildUpstreamUrl, sidecarKeyForRequestType } from './activeConfig'
import { authenticateUser } from './auth'
import {
  checkCostBudget,
  checkTeamByokBudget,
  commitTokenConsumption,
  commitTeamByokConsumption,
  getUserBudgetState,
  resolveEnforcementMode,
  resolvePlanBudgetFor,
  resolveSpeedMultiplier,
  resolveCacheBillingFactor,
  billableTokenTotal,
  shortenBudgetStateCacheTtl,
  type CostBudgetCheck,
  type UserBudgetState,
} from './billing'
import { isSpeedAllowedForPlanState } from './planGate'
import { HttpError, jsonError, methodNotAllowed } from './errors'
import { buildResponseHeaders, buildUpstreamHeaders, corsPreflight, withCors } from './headers'
import { createRequestId, logRequest } from './logging'
import { injectStreamOptions, observeUsage } from './usage'
import { withStreamIdleTimeout } from './streamWatchdog'
import { ensureGeminiThoughtSummaries, ensureVertexPublisher } from './geminiThinking'
import { applyDashScopePromptCache } from './dashscopePromptCache'
import { applyReasoningEffort } from './applyReasoningEffort'
import type { Env, Fetcher, WaitUntilContext } from './types'

export interface HandlerOptions {
  fetcher?: Fetcher
  /** ExecutionContext do runtime (testes injetam um coletor próprio). */
  ctx?: WaitUntilContext
}

function notFound(): Response {
  return jsonError(404, 'tm_not_found', 'Not found.')
}

// Timeout até aos HEADERS do upstream — o stream em si não tem limite (gerações
// longas são normais; modelos de reasoning demoram dezenas de segundos até ao
// primeiro byte, daí a folga). Sem isto, um provider que aceita a ligação e
// nunca responde deixava o pedido pendurado até o runtime o matar com "code
// had hung and would never generate a response" (visto em produção,
// 2026-06-11) — e a IDE via um chat morto sem erro. Knobs por env para ajustar
// sem deploy de código.
//
// DOIS limites, escolhidos pelo `stream` do corpo: num pedido streaming os
// headers chegam com o primeiro chunk, por isso headers tardios ≈ hang real.
// Num pedido NÃO-streaming os headers só chegam quando a geração INTEIRA
// termina — a compactação da IDE (contextManager: transcript completo,
// stream:false, max_tokens 16k) excede 120s legitimamente em modelos com
// thinking, e o limite curto convertia-a num 504 falso-positivo (visto em
// produção 2026-06-12, Vertex Gemini saudável a 2-5s em pedidos normais).
const DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS = 120_000
const DEFAULT_UPSTREAM_NONSTREAM_HEADER_TIMEOUT_MS = 300_000

export function resolveUpstreamHeaderTimeout(env: Env, streamRequested: boolean): number {
  const envKey = streamRequested ? 'UPSTREAM_HEADER_TIMEOUT_MS' : 'UPSTREAM_NONSTREAM_HEADER_TIMEOUT_MS'
  const fallback = streamRequested
    ? DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS
    : DEFAULT_UPSTREAM_NONSTREAM_HEADER_TIMEOUT_MS
  const raw = typeof env[envKey] === 'string' ? Number(env[envKey]) : NaN
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

// Timeout de INATIVIDADE do stream DEPOIS dos headers — o segundo watchdog que
// o header-timeout (até ao 1º byte) não dá: re-arma a cada chunk e aborta o
// upstream se não fluírem bytes durante o intervalo (provider que estola a meio
// da geração → "code had hung" do runtime). 90s é folgado para modelos de
// reasoning (gaps entre tokens) mas finito; mata o hang em ~90s em vez dos
// ~minutos até o runtime cancelar. 0/negativo desliga (ver streamWatchdog.ts).
const DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 90_000

// Timeout de leitura do corpo do CLIENTE. O terceiro buraco da mesma família:
// o header-timeout cobre o upstream até ao 1º byte, o stream-idle cobre o corpo
// do upstream depois disso, e NADA cobria o corpo que o cliente nos envia.
//
// `await request.json()` (bodyWithActiveModel) espera indefinidamente se o
// cliente abre o POST, manda os headers e estola a meio do upload — TCP vivo,
// bytes parados. Nesse caso `request.signal` NÃO dispara (o cliente não
// abortou), portanto nem o listener de abort salva. O pedido fica pendurado até
// o runtime o matar com "code had hung and would never generate a response".
//
// Não é hipotético: a IDE manda prompts de centenas de KB (83 929 tokens
// observados em produção), e um portátil a adormecer ou uma troca de rede a
// meio do upload produz exatamente isto.
//
// 60s é folgado — 350 KB a 100 kbit/s são ~28s — e continua finito. 0/negativo
// desliga (mesma convenção dos outros knobs).
const DEFAULT_CLIENT_BODY_TIMEOUT_MS = 60_000

export function resolveClientBodyTimeout(env: Env): number {
  const raw = typeof env.CLIENT_BODY_TIMEOUT_MS === 'string'
    ? Number(env.CLIENT_BODY_TIMEOUT_MS)
    : NaN
  if (Number.isFinite(raw)) return raw
  return DEFAULT_CLIENT_BODY_TIMEOUT_MS
}

export function resolveUpstreamStreamIdleTimeout(env: Env): number {
  const raw = typeof env.UPSTREAM_STREAM_IDLE_TIMEOUT_MS === 'string'
    ? Number(env.UPSTREAM_STREAM_IDLE_TIMEOUT_MS)
    : NaN
  // Finito mas <= 0 desliga deliberadamente; NaN cai no default.
  if (Number.isFinite(raw)) return raw
  return DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS
}

// ── Retry de falhas TRANSITÓRIAS do pedido ao provedor ───────────────────────
// Default 2 re-tentativas (3 tentativas no total); `UPSTREAM_MAX_RETRIES` afina
// sem redeploy (0 desliga).
const DEFAULT_UPSTREAM_MAX_RETRIES = 2

export function resolveUpstreamMaxRetries(env: Env): number {
  const raw = typeof env.UPSTREAM_MAX_RETRIES === 'string' ? Number(env.UPSTREAM_MAX_RETRIES) : NaN
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_UPSTREAM_MAX_RETRIES
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Backoff curto antes de cada re-tentativa (índice 0 = antes da 1ª).
function retryBackoffMs(attempt: number): number {
  const ladder = [250, 750, 1500]
  return ladder[Math.min(attempt, ladder.length - 1)]
}

// Distingue um erro de GATEWAY transitório (re-tentável) de um erro REAL da API
// (propaga já). A API do provider responde JSON; uma página HTML num não-2xx é
// o gateway/edge a rejeitar ANTES da API — ex.: a página Tengine "400 Bad
// Request" do DashScope (`dashscope-us…:50001`). 502/503/504 são sempre
// transitórios. 429 (rate limit) NÃO é re-tentado aqui — propaga com
// retry-after para o cliente recuar.
function isRetryableGatewayError(res: Response): boolean {
  if (res.ok) return false
  if (res.status === 502 || res.status === 503 || res.status === 504) return true
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  return contentType.includes('text/html')
}

interface PreparedBody {
  body: string
  /** Tamanho do corpo final em chars — input do fallback de estimativa. */
  chars: number
  /** `stream: true` no corpo — seleciona o timeout de headers adequado. */
  streamRequested: boolean
}

async function bodyWithActiveModel(
  request: Request,
  model: string,
  provider: string,
  baseUrl: string,
  extraBody?: Record<string, unknown>,
  isGoogleOAuth = false,
  bodyTimeoutMs = 0,
): Promise<PreparedBody> {
  let parsed: unknown
  // O timer TEM de ser limpo no caminho feliz. Sem o clearTimeout ficava armado
  // até ao fim do intervalo em TODOS os pedidos — um timer pendurado por
  // pedido, a segurar o isolate. Mesmo padrão do headerTimer abaixo e do
  // watchdog de stream; foi o salto da suite de testes de 3s para 60s que
  // denunciou a fuga.
  let bodyTimer: ReturnType<typeof setTimeout> | null = null
  try {
    // A corrida existe para converter um upload estolado num 408 limpo em vez
    // de um pedido pendurado (ver resolveClientBodyTimeout). O `json()` fica
    // pendente — não há como o cancelar — mas devolvemos resposta e o runtime
    // liberta o isolate; o que interessa é NUNCA ficarmos sem responder.
    parsed = bodyTimeoutMs > 0
      ? await Promise.race([
        request.json(),
        new Promise<never>((_, reject) => {
          bodyTimer = setTimeout(
            () => reject(new HttpError(408, 'tm_request_body_timeout', 'Request body was not fully received in time.')),
            bodyTimeoutMs,
          )
        }),
      ])
      : await request.json()
  } catch (err) {
    // O timeout NÃO pode sair como "must be valid JSON": mentiria sobre a causa
    // e mandaria quem depura procurar um bug de serialização no cliente.
    if (err instanceof HttpError) throw err
    throw new HttpError(400, 'tm_bad_request', 'Request body must be valid JSON.')
  } finally {
    if (bodyTimer !== null) clearTimeout(bodyTimer)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'tm_bad_request', 'Request body must be a JSON object.')
  }

  const clientBody = parsed as Record<string, unknown>

  // extraBody da config ativa (ex.: DashScope enable_search) — só campos
  // que o cliente NÃO definiu, para nunca sobrepor intenção explícita.
  const merged: Record<string, unknown> = { ...clientBody }
  if (extraBody) {
    for (const [key, value] of Object.entries(extraBody)) {
      if (!(key in merged)) merged[key] = value
    }
  }
  // Vertex (google_oauth) exige um id `<publisher>/<model>`; assume `google/`
  // quando a config guardou um id sem publisher (ver ensureVertexPublisher).
  merged.model = isGoogleOAuth ? ensureVertexPublisher(model) : model

  // Gemini/Vertex: torna o thinking (sempre ativo no modelo) VISÍVEL no stream.
  // Ao contrário do GLM/Qwen/MiMo (que emitem reasoning_content sem pedir), o
  // Gemini só transmite os resumos com include_thoughts — sem isto o reasoning
  // do Gemini nunca chegava à IDE enquanto os outros modelos apareciam.
  if (isGoogleOAuth) ensureGeminiThoughtSummaries(merged)

  // Effort do utilizador — valor NATIVO do frontend (reasoningEffortModels.ts).
  // DEPOIS do merge do extraBody. applyReasoningEffort escreve reasoning_effort
  // e os companions por provider (DashScope enable_thinking, z.AI thinking.type;
  // limpa thinking em Kimi/Grok). Ver applyReasoningEffort.ts + docs oficiais.
  const effortHeader = request.headers.get('X-TM-Reasoning-Effort')?.trim()
  if (effortHeader) {
    applyReasoningEffort(merged, effortHeader, { provider, baseUrl, model })
  }

  // `stream_options.include_usage` garante que providers OpenAI-compatible
  // devolvem o objeto `usage` no chunk final — é a fonte autoritativa da
  // contabilidade de billing (usage.ts / billing.ts).
  const withUsage = injectStreamOptions(merged)
  const cacheStats = applyDashScopePromptCache(withUsage, { provider, baseUrl, model })
  if (cacheStats.found) {
    const tag = cacheStats.cacheControlApplied ? 'explicit' : 'implicit'
    console.info(
      `[ai-pass-through] dashscope prompt cache ${tag} ` +
        `model=${model} static=${cacheStats.staticBytes}B dynamic=${cacheStats.dynamicBytes}B`,
    )
  }

  const body = JSON.stringify(withUsage)
  return { body, chars: body.length, streamRequested: merged.stream === true }
}

async function handleChatCompletions(
  request: Request,
  env: Env,
  options: HandlerOptions = {},
): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed()

  const requestId = createRequestId(request)
  const startedAt = Date.now()
  const user = await authenticateUser(request, env)
  // Sidecars (X-Request-Type → KV `sidecar:*`): web_search, vision, fim,
  // context-planner e a família memory-*/summarize correm em modelos baratos/
  // especializados publicados pelo admin; alguns tipos podem degradar para a
  // config ativa, outros têm contrato próprio e falham rápido.
  // O header NUNCA segue upstream (filtro em headers.ts) e a resposta leva
  // X-TM-Config-Key para o cliente saber quem serviu.
  const requestType = request.headers.get('x-request-type')
  // `let` because Team BYOK may override the MAIN-path config after we know the
  // requester's team (resolved below, post-suspension-gate).
  let active = await getConfigForRequest(env, requestType)
  let config = active.config

  // Sidecars ESPECIALIZADOS (vision/web_search/fim) NÃO podem degradar para o
  // modelo ativo GERAL: mandar uma imagem a um modelo de texto dá 404 upstream,
  // "pesquisar" sem motor alucina, FIM sem template devolve lixo. Sem o sidecar
  // publicado falha já com 503, em vez de um pedido upstream condenado (2-3s +
  // 404 + billing desperdiçado). Os clientes JÁ recusam o resultado degradado
  // destes tipos (visão→null→texto, web_search→erro honesto, FIM→Ollama local),
  // por isso o 503 dá o MESMO desfecho — só mais limpo, rápido e barato. O tipo
  // `vision` só é enviado quando o modelo ativo é cego (cliente verifica o
  // perfil antes), logo nunca há um modelo ativo com visão a ser bloqueado aqui.
  // `context-planner` também não pode degradar silenciosamente: ele tem contrato
  // JSON e o cliente já tem fallback explícito para o modelo de código quando o
  // sidecar utilitário falha. `summarize`/memory ficam de fora — o modelo ativo
  // sabe resumir/extrair, degradam como desenhado.
  const requestedSidecar = sidecarKeyForRequestType(requestType)
  const strictSidecarRequestType = ['vision', 'web_search', 'fim', 'context-planner'].includes(
    requestType?.trim().toLowerCase() ?? '',
  )
  if (requestedSidecar && strictSidecarRequestType && active.key !== requestedSidecar) {
    return jsonError(
      503,
      'tm_sidecar_unavailable',
      `No sidecar is published for "${requestType}" requests; the active model cannot serve this request type.`,
    )
  }

  const fetcher = options.fetcher ?? globalThis
  const waitUntil = options.ctx?.waitUntil?.bind(options.ctx) ?? ((p: Promise<unknown>) => { void p })

  // ── Billing pré-voo ──────────────────────────────────────────────────
  // UMA leitura cacheada (60s) de users/{uid} serve o gate de orçamento E a
  // elegibilidade do TM Speed. Lookup falhado → state null → degrada (sem
  // gate, sem headers de budget, speed não elegível) — billing nunca parte
  // o chat. Ver billing.ts para o racional completo e os modos off/shadow/
  // enforce.
  const idToken = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const enforcement = resolveEnforcementMode(env)
  let budgetState: UserBudgetState | null = null
  let budgetCheck: CostBudgetCheck | null = null

  // ── Gate de suspensão de conta ───────────────────────────────────────
  // SEMPRE, independente do modo de billing (off/shadow/enforce). Uma conta
  // bloqueada ou soft-deleted por um admin (users/{uid}.blocked|deleted) é
  // rejeitada antes do upstream. A mesma leitura (cache 60s) alimenta o gate
  // de orçamento e o TM Speed abaixo. Leitura falhada → null → fail-open
  // (mesma filosofia de degradação do billing); o IDE faz o enforcement de
  // UX em tempo-real, esta é a defesa em profundidade no servidor.
  budgetState = await getUserBudgetState(env, user.userId, idToken, fetcher)
  if (budgetState && (budgetState.blocked || budgetState.deleted)) {
    return jsonError(
      403,
      'tm_account_suspended',
      'This account has been suspended. Please contact support.',
    )
  }

  // ── Team BYOK ────────────────────────────────────────────────────────
  // Se a equipa do membro tem uma config `team:{teamId}` publicada e ativa, o
  // modelo PRINCIPAL passa a ir ao provedor/chave da própria equipa (a equipa
  // paga ao provedor) e o metering da TM é saltado. Só o caminho principal:
  // pedidos de sidecar (memória/visão/…) continuam na infra TM, coerente com a
  // política de plano pago. Config inválida/ausente/desativada → degrada para
  // o modelo gerido (nunca parte o chat).
  let teamByok = false
  if (budgetState?.team?.teamId && !requestedSidecar) {
    const tb = await getTeamByokConfig(env, budgetState.team.teamId)
    if (tb) {
      active = tb
      config = tb.config
      teamByok = true
    }
  }

  // Hoisted: o budget base do plano/tier — reusado para o pieTotal do contexto
  // de equipa nos headers (§3.5).
  let planBudget = 0
  // Team BYOK não consome tokens da TM → sem gate de orçamento (nem fatia de
  // equipa) para esses pedidos.
  if (enforcement !== 'off' && !teamByok) {
    if (budgetState) {
      // Budget do plano vem do subscription_plans do admin (cache 5 min em
      // billing.ts); hardcoded/PLAN_BUDGETS_JSON só como fallback — senão o
      // gate 402 e o consumedPct dos headers divergem da web/control-plane.
      planBudget = await resolvePlanBudgetFor(env, budgetState.plan, idToken, fetcher)
      budgetCheck = checkCostBudget(budgetState, { [budgetState.plan]: planBudget })
      // Perto do limite (≥95% / em overage) ou já rejeitado: encurta o TTL
      // da cache de estado (60s → ≤10s). Ver shortenBudgetStateCacheTtl —
      // trava o overshoot de runs paralelos e desbloqueia compras de extra
      // sem esperar o minuto inteiro. O guard `tokenBudget > 0` exclui os
      // planos SEM orçamento (byok-only / plano desconhecido): esses são
      // `rejected` permanentemente por construção e em shadow continuam a
      // conversar — sem o guard ficavam com TTL de 10s para sempre (6x
      // leituras Firestore sem estarem perto de limite nenhum).
      if (
        budgetCheck.tokenBudget > 0 &&
        (!budgetCheck.allowed ||
          budgetCheck.status === 'allowed_critical' ||
          budgetCheck.status === 'allowed_overage')
      ) {
        shortenBudgetStateCacheTtl(user.userId)
      }
    }
    if (budgetCheck && !budgetCheck.allowed) {
      // EQUIPA: o hard cap da fatia é o CONTRATO da feature e não há
      // utilizadores legados — bloqueia já em 'shadow' (código dedicado → a IDE
      // mostra "fala com o teu admin"; o membro não compra, só o admin realoca).
      if (budgetState?.team) {
        return jsonError(
          402,
          'tm_team_slice_exhausted',
          'Your team slice is exhausted for this cycle. Ask your team admin to increase your allocation.',
        )
      }
      // PESSOAL: só bloqueia em 'enforce' — em 'shadow' apenas mede/reporta,
      // para não 402-ar planos pessoais existentes durante o rollout.
      if (enforcement === 'enforce') {
        return jsonError(
          402,
          'tm_budget_exhausted',
          'Token budget exhausted for this cycle. Buy extra usage or wait for the cycle reset.',
        )
      }
    }
  }

  // ── Team BYOK: orçamento VIRTUAL opcional (opt-in pelo admin) ───────────────
  // Quando a config da equipa define um `pool` (> 0), medimos o uso BYOK contra
  // a pool bruta da equipa. Não há fatia por membro em BYOK: percentAllocation
  // só controla o plano TM gerido. Sem pool → pass-through puro (sem gate, sem
  // commit), como antes. A pool é uma ESTIMATIVA do que o admin pagou ao
  // provedor, NÃO o saldo real.
  let teamByokMetered = false
  if (teamByok && config.pool && config.pool > 0 && budgetState?.team) {
    teamByokMetered = true
    if (enforcement !== 'off') {
      const gate = checkTeamByokBudget(config.pool, budgetState.team)
      if (!gate.allowed) {
        // Mesma razão do gate principal: o consumo BYOK da equipa vive na
        // MESMA entrada de cache de 60s — sem encurtar, um top-up do admin
        // ficava "colado" em 402 até um minuto.
        shortenBudgetStateCacheTtl(user.userId)
        return jsonError(
          402,
          'tm_team_byok_exhausted',
          'The team BYOK budget is exhausted. Ask your team admin to top it up.',
        )
      }
    }
  }

  // TM Speed (`/speed` na IDE): a app envia `X-TM-Speed: true` como sinal de
  // routing para ESTE worker — o header nunca segue upstream (o filtro x-tm-*
  // em headers.ts continua a aplicar-se). Só troca de modelo se o admin tiver
  // publicado `speedModel` na config ativa E o plano do utilizador for
  // elegível (derivado do MESMO budgetState — zero leituras extra); em
  // qualquer outro caso o pedido segue no modelo normal em vez de falhar,
  // para o toggle da IDE nunca quebrar o chat. A resposta leva
  // `X-TM-Speed-Applied` e o multiplicador de cobrança é aplicado AQUI no
  // commit (server-side) — a IDE usa o header só para o indicador visual.
  const speedRequested = request.headers.get('x-tm-speed') === 'true'
  let speedEligible = false
  if (speedRequested && config.speedModel) {
    // budgetState já foi lido (incondicionalmente) no gate de suspensão acima,
    // em QUALQUER modo de billing, e a leitura é cacheada 60s (inclui resultados
    // null). A elegibilidade do speed reusa esse mesmo estado — zero leituras
    // extra, zero round-trips.
    speedEligible = isSpeedAllowedForPlanState(budgetState)
  }
  // Team BYOK usa o modelo da equipa (sem speedModel da TM) — speed é no-op.
  const speedApplied = !teamByok && speedRequested && !!config.speedModel && speedEligible
  const model = speedApplied && config.speedModel ? config.speedModel : config.model

  const upstreamUrl = buildUpstreamUrl(config)
  const prepared = await bodyWithActiveModel(
    request,
    model,
    config.provider,
    config.baseUrl,
    config.extraBody,
    config.authScheme === 'google_oauth',
    resolveClientBodyTimeout(env),
  )
  const { headers: upstreamHeaders, providerKey } = await buildUpstreamHeaders(request, config, env, fetcher)

  // O signal do upstream é um controller próprio em vez de request.signal
  // direto: o abort do cliente continua a propagar durante TODO o ciclo de
  // vida (corpo do stream incluído), mas ganhamos um segundo gatilho — o
  // timeout de headers — sem nunca cortar um stream já em curso (o timer é
  // limpo assim que os headers chegam). `upstreamAbort` é mutável: cada
  // re-tentativa usa um controller fresco e este listener aborta sempre o que
  // está em voo (fecha sobre a variável, não o valor).
  let upstreamAbort = new AbortController()
  const propagateClientAbort = (): void => upstreamAbort.abort()
  if (request.signal.aborted) propagateClientAbort()
  else request.signal.addEventListener('abort', propagateClientAbort, { once: true })

  // Re-tenta o pedido ao provedor em falhas TRANSITÓRIAS de gateway/edge — o
  // caso clássico é a página HTML "400 Bad Request" do Tengine do DashScope
  // (rejeição no gateway, antes da API), além de 502/503/504, timeout de
  // headers e erros de transporte. Seguro porque um não-2xx significa que
  // NENHUM stream começou; re-enviar o mesmo corpo (string) é idempotente.
  // Erros REAIS da API (JSON 4xx) NÃO são re-tentados — propagam já.
  const maxRetries = resolveUpstreamMaxRetries(env)
  let upstream: Response
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      upstreamAbort = new AbortController()
      if (request.signal.aborted) upstreamAbort.abort()
    }
    let upstreamHeadersTimedOut = false
    const headerTimer = setTimeout(() => {
      upstreamHeadersTimedOut = true
      upstreamAbort.abort()
    }, resolveUpstreamHeaderTimeout(env, prepared.streamRequested))

    let res: Response | null = null
    try {
      res = await fetcher.fetch(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
        body: prepared.body,
        signal: upstreamAbort.signal,
      })
    } catch {
      // Erro de transporte ou abort — decidido abaixo.
    } finally {
      clearTimeout(headerTimer)
    }

    // Erro de transporte ou timeout de headers → falha já, SEM retry (como o
    // design original): são falhas "lentas"/persistentes e re-tentar só compõe
    // a latência. O retry abaixo cobre apenas os erros de GATEWAY recebidos
    // (HTML 400 / 502-504) — rejeições rápidas e quase sempre transitórias.
    if (!res) {
      if (upstreamHeadersTimedOut) {
        console.error(`[ai-pass-through] upstream header timeout user=${user.userId} url=${upstreamUrl}`)
        return jsonError(504, 'tm_upstream_timeout', 'Active AI provider did not respond in time.')
      }
      return jsonError(502, 'tm_upstream_transport_error', 'Unable to reach active AI provider.')
    }

    if (attempt < maxRetries && isRetryableGatewayError(res)) {
      console.warn(
        `[ai-pass-through] upstream gateway error ${res.status} ` +
          `(${res.headers.get('content-type') ?? '?'}) retry ${attempt + 1}/${maxRetries} user=${user.userId}`,
      )
      try {
        await res.body?.cancel()
      } catch {
        // corpo já fechado/consumido — ignora.
      }
      await sleep(retryBackoffMs(attempt))
      continue
    }

    upstream = res
    break
  }

  const durationMs = Date.now() - startedAt

  let responseBody: ReadableStream | string | null = upstream.body
  if (upstream.status === 400) {
    // Este `text()` corre ANTES do watchdog de stream (o corpo deixa de ser um
    // ReadableStream aqui), portanto é o único sítio do caminho do upstream sem
    // supervisão nenhuma. Um gateway que devolve 400 + headers e depois segura a
    // ligação penduraria o pedido — o mesmo modo de falha que o watchdog cobre
    // no caminho 2xx. Curto de propósito: o corpo de um erro é pequeno; se não
    // chegar em 10s, o texto não vale o pedido pendurado.
    let errTimer: ReturnType<typeof setTimeout> | null = null
    const errorText = await Promise.race([
      upstream.text().catch(() => ''),
      new Promise<string>(resolve => {
        errTimer = setTimeout(() => {
          void upstream.body?.cancel().catch(() => { /* já fechado */ })
          resolve('[corpo do erro não chegou a tempo]')
        }, 10_000)
      }),
    ]).finally(() => { if (errTimer !== null) clearTimeout(errTimer) })
    console.error(`[ai-pass-through] Upstream 400 Error Body:`, errorText)
    responseBody = errorText
  }

  // ── Captura de usage + commit ────────────────────────────────────────
  // Só em respostas 2xx (erro do provider não consome tokens cobráveis) e
  // com billing ligado. O corpo devolvido é byte-idêntico (usage.ts); o
  // commit corre em waitUntil DEPOIS do stream terminar para nunca atrasar
  // o primeiro byte. Aborts do cliente liquidam com o que foi observado.
  // Contabilidade pós-stream — corre em waitUntil DEPOIS de o stream terminar,
  // para nunca atrasar o primeiro byte. Dois caminhos mutuamente exclusivos:
  //  • gerido (`!teamByok`): commitTokenConsumption (multiplicador, overage,
  //    fatia de equipa) contra o budget da TM.
  //  • Team BYOK com pool (`teamByokMetered`): commitTeamByokConsumption (1x,
  //    tokens reais) contra o ledger virtual da equipa.
  // Team BYOK SEM pool = pass-through: não entra aqui (nenhuma das condições).
  // Em ambos só se comita em `upstream.ok` → um 502/erro nunca consome.
  const meterBody = enforcement !== 'off' && upstream.ok && upstream.body
    && responseBody === upstream.body && (!teamByok || teamByokMetered)
    ? upstream.body
    : null
  if (meterBody) {
    const observer = observeUsage(
      meterBody,
      upstream.headers.get('content-type'),
      prepared.chars,
    )
    responseBody = observer.body
    request.signal.addEventListener('abort', observer.settle, { once: true })

    const multiplier = speedApplied ? resolveSpeedMultiplier(env) : 1
    const asOverage = budgetCheck?.asOverage ?? false
    const teamId = budgetState?.team?.teamId
    waitUntil(observer.done.then(async (usage) => {
      if (!usage) return
      // Observabilidade do fallback: quando o provider omite o objeto
      // `usage` (apesar do include_usage), cobramos por estimativa de
      // bytes — grosseira. Este log permite medir a frequência e o drift
      // em produção; se aparecer com regularidade, o provider/config
      // precisa de atenção, não a estimativa de mais precisão.
      if (!usage.authoritative) {
        console.warn(
          `[billing] usage ESTIMATED (provider omitted usage object) user=${user.userId} ` +
          `prompt≈${usage.promptTokens} completion≈${usage.completionTokens}`,
        )
      }
      // Team BYOK: ledger virtual da equipa, tokens RAW (1x, sem multiplicador
      // da TM — é a despesa do admin no provedor, não inferência gerida).
      // Desconto de cache: tokens de prompt cacheados faturam a
      // resolveCacheBillingFactor (default 0.5). Vale para o billing gerido
      // E para o ledger Team BYOK (o provider já descontou o cache na fatura
      // real do admin — contá-lo a 100% no ledger virtual inflava a despesa).
      const cacheFactor = resolveCacheBillingFactor(env)
      const billableTotal = billableTokenTotal(usage, cacheFactor)
      if (usage.cachedTokens > 0) {
        console.log(
          `[billing] cache discount user=${user.userId} prompt=${usage.promptTokens} ` +
          `cached=${usage.cachedTokens}@${cacheFactor}x → billablePrompt=${billableTotal - usage.completionTokens} completion=${usage.completionTokens}`,
        )
      }
      if (teamByokMetered && teamId) {
        await commitTeamByokConsumption({
          env,
          userId: user.userId,
          idToken,
          teamId,
          rawTokens: billableTotal,
          fetcher,
        })
        return
      }
      const rawTokens = Math.ceil(billableTotal * multiplier)
      await commitTokenConsumption({
        env,
        userId: user.userId,
        idToken,
        rawTokens,
        asOverage,
        fetcher,
        // Membro de equipa: dual-write na equipa (total + fatia), não no user.
        team: budgetState?.team ? { teamId: budgetState.team.teamId } : undefined,
      })
    }))
  }

  const upstreamHost = (() => {
    try { return new URL(upstreamUrl).host } catch { return upstreamUrl }
  })()
  await logRequest({
    requestId,
    userId: user.userId,
    provider: config.provider,
    model,
    upstreamStatus: upstream.status,
    durationMs,
    providerKey,
    configSource: active.source,
    configKey: active.key,
    teamByok,
    upstreamHost,
  })
  // Greppable one-liner for `wrangler tail` during a Team BYOK e2e: proves the
  // request was served by the TEAM's own provider/key, not the internal model.
  // With a virtual pool the team's BYOK ledger IS metered (1x, raw); without
  // one it's pure pass-through (no metering) — the suffix says which.
  if (teamByok) {
    console.info(
      `[team-byok] SERVED via team key → provider=${config.provider} model=${model} ` +
        `host=${upstreamHost} status=${upstream.status} config=${active.key} ` +
        `(${teamByokMetered ? `virtual pool METERED 1x, pool=${config.pool}` : 'TM model+metering BYPASSED'})`,
    )
  }

  // ── Watchdog de inatividade do stream ────────────────────────────────
  // O header-timeout acima já foi limpo (finally do fetch) — a partir daqui
  // NADA supervisionava o corpo. Envolve qualquer corpo que ainda seja um
  // stream (sai como string só no ramo 400) num watchdog que re-arma a cada
  // chunk e aborta o MESMO upstreamAbort se o provider estolar a meio. Sem
  // isto, um stall pós-headers ficava pendurado até o runtime o matar com
  // "code had hung and would never generate a response".
  if (responseBody instanceof ReadableStream) {
    responseBody = withStreamIdleTimeout(
      responseBody,
      () => upstreamAbort.abort(),
      resolveUpstreamStreamIdleTimeout(env),
    )
  }

  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildResponseHeaders(upstream, {
      requestId,
      provider: config.provider,
      model,
      speedApplied,
      teamByok,
      configSource: active.source,
      configKey: active.key,
      // Janela de contexto real do modelo ativo (quando declarada na config) —
      // emitida em X-Model-Context-Window para a IDE alinhar a pressão de
      // contexto e o auto-compact com a janela verdadeira do modelo.
      contextWindow: config.contextWindow,
      // Teto de saída — emitido em X-Model-Max-Output-Tokens pela mesma razão.
      maxOutputTokens: config.maxOutputTokens,
      // Capacidades declaradas na config — emitidas em X-Model-Capabilities
      // para a IDE deixar de herdar as flags de outro modelo.
      capabilities: config.capabilities,
      // Estado pré-voo — o updateFromHeaders da IDE consome exatamente estes
      // nomes (billingStore.ts). O pós-commit chega nos headers do PRÓXIMO
      // turno; a IDE cobre o intervalo com a estimativa otimista local.
      budget: budgetState && budgetCheck
        ? {
            // H4: membro de equipa → reporta o plano-BASE (team-pro→pro,
            // team-max→max), não o tier cru, para o billingStore da IDE
            // (tipado UserPlanName) não receber um valor desconhecido.
            plan: budgetState.team ? (budgetState.plan === 'team-max' ? 'max' : 'pro') : budgetState.plan,
            status: budgetCheck.status,
            consumedPct: budgetCheck.consumedPct,
            tokensConsumed: budgetState.tokensConsumed,
            extraUsageBalance: budgetState.extraUsageBalance,
            cycleEnd: budgetState.cycleEnd,
            // §3.5: contexto de equipa (tier cru + fatia/bolo em tokens) para a
            // IDE enquadrar "a tua fatia / o bolo". sliceTokens = teto do membro.
            team: budgetState.team
              ? {
                  teamId: budgetState.team.teamId,
                  tier: budgetState.plan,
                  sliceTokens: budgetCheck.tokenBudget,
                  pieTotal: planBudget + budgetState.team.purchasedExtra,
                }
              : undefined,
          }
        : undefined,
    }),
  })
}

export async function handleRequest(
  request: Request,
  env: Env,
  options: HandlerOptions = {},
): Promise<Response> {
  const url = new URL(request.url)

  try {
    if (request.method === 'OPTIONS') {
      return corsPreflight(request)
    }
    if (url.pathname === '/v1/chat/completions') {
      return withCors(await handleChatCompletions(request, env, options), request)
    }
    return withCors(notFound(), request)
  } catch (error) {
    if (error instanceof HttpError) {
      return withCors(jsonError(error.status, error.type, error.message), request)
    }
    return withCors(jsonError(500, 'tm_internal_error', 'Internal error.'), request)
  }
}

export default {
  fetch(request: Request, env: Env, ctx?: WaitUntilContext): Promise<Response> {
    return handleRequest(request, env, { ctx })
  },
}
