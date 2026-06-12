import { getActiveConfig, buildUpstreamUrl } from './activeConfig'
import { authenticateUser } from './auth'
import {
  checkCostBudget,
  commitTokenConsumption,
  getUserBudgetState,
  resolveEnforcementMode,
  resolvePlanBudgetFor,
  resolveSpeedMultiplier,
  type CostBudgetCheck,
  type UserBudgetState,
} from './billing'
import { isSpeedAllowedForPlanState } from './planGate'
import { HttpError, jsonError, methodNotAllowed } from './errors'
import { buildResponseHeaders, buildUpstreamHeaders, corsPreflight, withCors } from './headers'
import { createRequestId, logRequest } from './logging'
import { injectStreamOptions, observeUsage } from './usage'
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
// 2026-06-11) — e a IDE via um chat morto sem erro. Knob por env para ajustar
// sem deploy de código.
const DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS = 120_000

function resolveUpstreamHeaderTimeout(env: Env): number {
  const raw = typeof env.UPSTREAM_HEADER_TIMEOUT_MS === 'string'
    ? Number(env.UPSTREAM_HEADER_TIMEOUT_MS)
    : NaN
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS
}

interface PreparedBody {
  body: string
  /** Tamanho do corpo final em chars — input do fallback de estimativa. */
  chars: number
}

async function bodyWithActiveModel(
  request: Request,
  model: string,
  extraBody?: Record<string, unknown>,
): Promise<PreparedBody> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    throw new HttpError(400, 'tm_bad_request', 'Request body must be valid JSON.')
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
  merged.model = model

  // `stream_options.include_usage` garante que providers OpenAI-compatible
  // devolvem o objeto `usage` no chunk final — é a fonte autoritativa da
  // contabilidade de billing (usage.ts / billing.ts).
  const withUsage = injectStreamOptions(merged)

  const body = JSON.stringify(withUsage)
  return { body, chars: body.length }
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
  const active = await getActiveConfig(env)
  const config = active.config
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
  if (enforcement !== 'off') {
    budgetState = await getUserBudgetState(env, user.userId, idToken, fetcher)
    if (budgetState) {
      // Budget do plano vem do subscription_plans do admin (cache 5 min em
      // billing.ts); hardcoded/PLAN_BUDGETS_JSON só como fallback — senão o
      // gate 402 e o consumedPct dos headers divergem da web/control-plane.
      const planBudget = await resolvePlanBudgetFor(env, budgetState.plan, idToken, fetcher)
      budgetCheck = checkCostBudget(budgetState, { [budgetState.plan]: planBudget })
    }
    if (enforcement === 'enforce' && budgetCheck && !budgetCheck.allowed) {
      return jsonError(
        402,
        'tm_budget_exhausted',
        'Token budget exhausted for this cycle. Buy extra usage or wait for the cycle reset.',
      )
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
    if (enforcement === 'off' && !budgetState) {
      // Com billing desligado o estado ainda não foi lido — lê só para o gate
      // de plano (mesma cache).
      budgetState = await getUserBudgetState(env, user.userId, idToken, fetcher)
    }
    speedEligible = isSpeedAllowedForPlanState(budgetState)
  }
  const speedApplied = speedRequested && !!config.speedModel && speedEligible
  const model = speedApplied && config.speedModel ? config.speedModel : config.model

  const upstreamUrl = buildUpstreamUrl(config)
  const prepared = await bodyWithActiveModel(request, model, config.extraBody)
  const { headers: upstreamHeaders, providerKey } = await buildUpstreamHeaders(request, config, env, fetcher)

  // O signal do upstream é um controller próprio em vez de request.signal
  // direto: o abort do cliente continua a propagar (listener abaixo, durante
  // TODO o ciclo de vida do fetch, corpo incluído), mas ganhamos um segundo
  // gatilho — o timeout de headers — sem nunca cortar um stream já em curso
  // (o timer é limpo assim que os headers chegam).
  const upstreamAbort = new AbortController()
  const propagateClientAbort = (): void => upstreamAbort.abort()
  if (request.signal.aborted) propagateClientAbort()
  else request.signal.addEventListener('abort', propagateClientAbort, { once: true })

  let upstreamHeadersTimedOut = false
  const headerTimer = setTimeout(() => {
    upstreamHeadersTimedOut = true
    upstreamAbort.abort()
  }, resolveUpstreamHeaderTimeout(env))

  let upstream: Response
  try {
    upstream = await fetcher.fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: prepared.body,
      signal: upstreamAbort.signal,
    })
  } catch {
    if (upstreamHeadersTimedOut) {
      console.error(`[ai-pass-through] upstream header timeout user=${user.userId} url=${upstreamUrl}`)
      return jsonError(504, 'tm_upstream_timeout', 'Active AI provider did not respond in time.')
    }
    return jsonError(502, 'tm_upstream_transport_error', 'Unable to reach active AI provider.')
  } finally {
    clearTimeout(headerTimer)
  }

  const durationMs = Date.now() - startedAt

  let responseBody: ReadableStream | string | null = upstream.body
  if (upstream.status === 400) {
    const errorText = await upstream.text()
    console.error(`[ai-pass-through] Upstream 400 Error Body:`, errorText)
    responseBody = errorText
  }

  // ── Captura de usage + commit ────────────────────────────────────────
  // Só em respostas 2xx (erro do provider não consome tokens cobráveis) e
  // com billing ligado. O corpo devolvido é byte-idêntico (usage.ts); o
  // commit corre em waitUntil DEPOIS do stream terminar para nunca atrasar
  // o primeiro byte. Aborts do cliente liquidam com o que foi observado.
  if (enforcement !== 'off' && upstream.ok && upstream.body && responseBody === upstream.body) {
    const observer = observeUsage(
      upstream.body,
      upstream.headers.get('content-type'),
      prepared.chars,
    )
    responseBody = observer.body
    request.signal.addEventListener('abort', observer.settle, { once: true })

    const multiplier = speedApplied ? resolveSpeedMultiplier(env) : 1
    const asOverage = budgetCheck?.asOverage ?? false
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
      const rawTokens = Math.ceil((usage.promptTokens + usage.completionTokens) * multiplier)
      await commitTokenConsumption({
        env,
        userId: user.userId,
        idToken,
        rawTokens,
        asOverage,
        fetcher,
      })
    }))
  }

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
  })

  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildResponseHeaders(upstream, {
      requestId,
      provider: config.provider,
      model,
      speedApplied,
      configSource: active.source,
      configKey: active.key,
      // Estado pré-voo — o updateFromHeaders da IDE consome exatamente estes
      // nomes (billingStore.ts). O pós-commit chega nos headers do PRÓXIMO
      // turno; a IDE cobre o intervalo com a estimativa otimista local.
      budget: budgetState && budgetCheck
        ? {
            plan: budgetState.plan,
            status: budgetCheck.status,
            consumedPct: budgetCheck.consumedPct,
            tokensConsumed: budgetState.tokensConsumed,
            extraUsageBalance: budgetState.extraUsageBalance,
            cycleEnd: budgetState.cycleEnd,
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
