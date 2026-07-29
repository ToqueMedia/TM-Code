import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test, { beforeEach } from 'node:test'
import { clearActiveConfigCache, getTeamByokConfig } from '../src/activeConfig'
import { encryptSecret } from '../src/byokCrypto'
import { clearJwksCache } from '../src/auth'
import { clearPlanBudgetCache, resolveEnforcementMode, resetBillingDisabledWarning } from '../src/billing'
import { clearAccessTokenCache } from '../src/googleAuth'
import { handleRequest } from '../src/index'
import { clearPlanCache } from '../src/planGate'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/dashscopePromptCache'
import type { Env } from '../src/types'

const activeConfig = {
  provider: 'mimo',
  model: 'mimo-v2.5-pro',
  baseUrl: 'https://provider.test/v1',
  chatCompletionsPath: '/chat/completions',
  authHeader: 'api-key',
  authScheme: 'none',
  apiKeyEnv: 'MIMO_API_KEY',
  enabled: true,
  updatedAt: '2026-06-09T00:00:00Z',
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_MODE: 'test_static',
    TEST_USER_TOKEN: 'valid-user-token',
    FIREBASE_PROJECT_ID: 'tm-test',
    ACTIVE_AI_CONFIG_JSON: JSON.stringify(activeConfig),
    MIMO_API_KEY: ' "mimo-secret" ',
    ...overrides,
  }
}

function request(pathname = '/v1/chat/completions', body: Record<string, unknown> = {}) {
  return new Request(`https://worker.test${pathname}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-user-token',
      'content-type': 'application/json',
      accept: 'text/event-stream',
      cookie: 'session=bad',
      'x-tm-internal': 'drop-me',
      'cf-connecting-ip': '127.0.0.1',
    },
    body: JSON.stringify(body),
  })
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`
}

/** Documento Firestore de utilizador para os mocks do pré-voo de billing. */
function firestoreUserDoc(opts: {
  plan?: string
  tokensConsumed?: number
  extraUsageBalance?: number
  cycleEnd?: string
  tokenBudgetOverride?: number
  blocked?: boolean
  deleted?: boolean
} = {}): Response {
  return Response.json({
    fields: {
      userPlan: { stringValue: opts.plan ?? 'explorer' },
      ...(opts.blocked !== undefined ? { blocked: { booleanValue: opts.blocked } } : {}),
      ...(opts.deleted !== undefined ? { deleted: { booleanValue: opts.deleted } } : {}),
      tokenBudget: {
        mapValue: {
          fields: {
            tokensConsumed: { integerValue: String(opts.tokensConsumed ?? 0) },
            extraUsageBalance: { integerValue: String(opts.extraUsageBalance ?? 0) },
            cycleEnd: { stringValue: opts.cycleEnd ?? '2026-12-31' },
            ...(opts.tokenBudgetOverride !== undefined
              ? { tokenBudgetOverride: { integerValue: String(opts.tokenBudgetOverride) } }
              : {}),
          },
        },
      },
    },
  })
}

/**
 * Fetcher mock com discriminação de destino: chamadas ao Firestore REST
 * (pré-voo de billing + commits) são servidas por stubs próprios e contadas
 * em `firestoreCalls`; tudo o resto vai para `response` e conta em `calls` —
 * preserva as asserções históricas de "quantas vezes o upstream foi chamado".
 */
function fakeFetcher(response: Response, firestoreDoc?: () => Response, planDoc?: () => Response) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit; body: any; headers: Headers }> = []
  const firestoreCalls: Array<{ input: RequestInfo | URL; method: string; body: any; headers: Headers }> = []
  const planQueryCalls: Array<{ body: any }> = []
  return {
    calls,
    firestoreCalls,
    planQueryCalls,
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input)
      const headers = new Headers(init?.headers)
      // Lookup do budget do plano (subscription_plans via runQuery) tem
      // contagem própria — NÃO entra em firestoreCalls para preservar as
      // asserções históricas de reads (users/{uid}) e commits.
      if (url.includes(':runQuery')) {
        planQueryCalls.push({ body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body })
        return planDoc ? planDoc() : Response.json([{ readTime: '2026-06-12T00:00:00Z' }])
      }
      if (url.includes('firestore.googleapis.com')) {
        firestoreCalls.push({
          input,
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
          headers,
        })
        if ((init?.method ?? 'GET') === 'POST') return Response.json({ writeResults: [] })
        return firestoreDoc ? firestoreDoc() : firestoreUserDoc()
      }
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
      calls.push({ input, init, body, headers })
      return response
    },
  }
}

/** Resposta runQuery com um doc de subscription_plans (tokenBudget do admin). */
function planBudgetDoc(tokenBudget: number): Response {
  return Response.json([{
    document: {
      name: 'projects/tm-test/databases/(default)/documents/subscription_plans/auto-id',
      fields: {
        planKey: { stringValue: 'whatever' },
        tokenBudget: { integerValue: String(tokenBudget) },
      },
    },
    readTime: '2026-06-12T00:00:00Z',
  }])
}

/** ctx de teste — coleciona promises do waitUntil para await explícito. */
function collectorCtx() {
  const tasks: Promise<unknown>[] = []
  return {
    tasks,
    ctx: { waitUntil(p: Promise<unknown>) { tasks.push(p) } },
  }
}

beforeEach(() => {
  clearActiveConfigCache()
  clearPlanCache()
  clearAccessTokenCache()
  clearPlanBudgetCache()
})

/** Fetcher que separa o lookup de plano (Firestore REST) do upstream do provider. */
function speedFetcher(opts: {
  plan?: string
  planResponse?: () => Response
  upstreamResponse?: () => Response
}) {
  const upstreamCalls: Array<{ input: RequestInfo | URL; body: any; headers: Headers }> = []
  const planCalls: Array<{ input: RequestInfo | URL; headers: Headers }> = []
  return {
    upstreamCalls,
    planCalls,
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input)
      const headers = new Headers(init?.headers)
      // Budget do plano (runQuery a subscription_plans): sem doc → fallback
      // hardcoded; não conta em planCalls (asserções de cache do user read).
      if (url.includes(':runQuery')) {
        return Response.json([{ readTime: '2026-06-12T00:00:00Z' }])
      }
      if (url.includes('firestore.googleapis.com')) {
        planCalls.push({ input, headers })
        if (opts.planResponse) return opts.planResponse()
        return Response.json({ fields: { userPlan: { stringValue: opts.plan ?? 'explorer' } } })
      }
      upstreamCalls.push({
        input,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        headers,
      })
      return opts.upstreamResponse ? opts.upstreamResponse() : Response.json({ ok: true })
    },
  }
}

function speedRequest(body: Record<string, unknown> = {}) {
  return new Request('https://worker.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-user-token',
      'content-type': 'application/json',
      'x-tm-speed': 'true',
    },
    body: JSON.stringify(body),
  })
}

const SPEED_CONFIG_JSON = JSON.stringify({ ...activeConfig, speedModel: 'mimo-v2.5-pro-ultraspeed' })

test('only POST /v1/chat/completions exists; provider routes return 404', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))

  const ok = await handleRequest(request('/v1/chat/completions'), env(), { fetcher })
  assert.equal(ok.status, 200)

  const providerRoute = await handleRequest(request('/v1/providers/mimo/chat/completions'), env(), { fetcher })
  assert.equal(providerRoute.status, 404)
  assert.equal(fetcher.calls.length, 1)
})

test('OPTIONS /v1/chat/completions returns CORS preflight without auth or upstream', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const preflight = new Request('https://worker.test/v1/chat/completions', {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:1420',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,x-stainless-lang',
    },
  })

  const res = await handleRequest(preflight, env({ ACTIVE_AI_CONFIG_JSON: undefined }), { fetcher })

  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:1420')
  assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
  assert.equal(res.headers.get('access-control-allow-headers'), 'authorization,content-type,x-stainless-lang')
  assert.equal(fetcher.calls.length, 0)
})

test('active config is required and must be enabled', async () => {
  const missing = await handleRequest(request(), env({ ACTIVE_AI_CONFIG_JSON: undefined }), {
    fetcher: fakeFetcher(Response.json({ ok: true })),
  })
  assert.equal(missing.status, 503)
  assert.match(await missing.text(), /tm_active_config_missing/)

  const disabled = await handleRequest(
    request(),
    env({ ACTIVE_AI_CONFIG_JSON: JSON.stringify({ ...activeConfig, enabled: false }) }),
    { fetcher: fakeFetcher(Response.json({ ok: true })) },
  )
  assert.equal(disabled.status, 503)
  assert.match(await disabled.text(), /tm_active_config_disabled/)
})

test('ACTIVE_AI_CONFIG_JSON is used when local KV binding has no active key', async () => {
  const emptyKv = { get: async () => null }
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const res = await handleRequest(
    request(),
    env({ ACTIVE_AI_CONFIG: emptyKv, ACTIVE_AI_CONFIG_JSON: JSON.stringify(activeConfig) }),
    { fetcher },
  )

  assert.equal(res.status, 200)
  assert.equal(fetcher.calls.length, 1)
  assert.equal(fetcher.calls[0].body.model, activeConfig.model)
})

test('worker injects active model and does not decide provider from request', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const res = await handleRequest(
    request('/v1/chat/completions', {
      provider: 'client-choice-ignored',
      model: 'client-model-replaced',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }),
    env(),
    { fetcher },
  )

  assert.equal(res.status, 200)
  assert.equal(String(fetcher.calls[0].input), 'https://provider.test/v1/chat/completions')
  assert.equal(fetcher.calls[0].body.model, activeConfig.model)
  assert.equal(fetcher.calls[0].body.provider, 'client-choice-ignored')
})

test('omits X-Model-Context-Window when the active config declares no window', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const res = await handleRequest(request('/v1/chat/completions', { stream: true }), env(), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-model-context-window'), null)
})

test('emits X-Model-Context-Window from the active config window', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true }),
    env({ ACTIVE_AI_CONFIG_JSON: JSON.stringify({ ...activeConfig, contextWindow: 200_000 }) }),
    { fetcher },
  )

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-model-context-window'), '200000')
  // Exposto via CORS para o browser conseguir lê-lo cross-origin.
  assert.match(
    res.headers.get('access-control-expose-headers') ?? '',
    /X-Model-Context-Window/,
  )
})

test('X-TM-Speed + paid plan switches to speedModel; header never reaches upstream', async () => {
  const fetcher = speedFetcher({ plan: 'pro' })
  const res = await handleRequest(
    speedRequest({ model: 'client-model-replaced', messages: [] }),
    env({ ACTIVE_AI_CONFIG_JSON: SPEED_CONFIG_JSON }),
    { fetcher },
  )

  assert.equal(res.status, 200)
  assert.equal(fetcher.planCalls.length, 1)
  assert.equal(fetcher.planCalls[0].headers.get('authorization'), 'Bearer valid-user-token')
  assert.equal(fetcher.upstreamCalls[0].body.model, 'mimo-v2.5-pro-ultraspeed')
  assert.equal(fetcher.upstreamCalls[0].headers.get('x-tm-speed'), null)
  assert.equal(res.headers.get('x-tm-model'), 'mimo-v2.5-pro-ultraspeed')
  assert.equal(res.headers.get('x-tm-speed-applied'), 'true')
})

test('X-TM-Speed on a non-eligible plan degrades to the active model instead of 403', async () => {
  const fetcher = speedFetcher({ plan: 'explorer' })
  const res = await handleRequest(
    speedRequest(),
    env({ ACTIVE_AI_CONFIG_JSON: SPEED_CONFIG_JSON }),
    { fetcher },
  )

  assert.equal(res.status, 200)
  assert.equal(fetcher.upstreamCalls[0].body.model, activeConfig.model)
  assert.equal(res.headers.get('x-tm-speed-applied'), 'false')
})

test('plan lookup failure degrades to the active model and keeps serving', async () => {
  const fetcher = speedFetcher({ planResponse: () => new Response('boom', { status: 500 }) })
  const res = await handleRequest(
    speedRequest(),
    env({ ACTIVE_AI_CONFIG_JSON: SPEED_CONFIG_JSON }),
    { fetcher },
  )

  assert.equal(res.status, 200)
  assert.equal(fetcher.upstreamCalls[0].body.model, activeConfig.model)
  assert.equal(res.headers.get('x-tm-speed-applied'), 'false')
})

test('plan verdict is cached: second speed request does not re-hit Firestore', async () => {
  const fetcher = speedFetcher({ plan: 'max' })
  const testEnv = env({ ACTIVE_AI_CONFIG_JSON: SPEED_CONFIG_JSON })

  await handleRequest(speedRequest(), testEnv, { fetcher })
  await handleRequest(speedRequest(), testEnv, { fetcher })

  assert.equal(fetcher.planCalls.length, 1)
  assert.equal(fetcher.upstreamCalls.length, 2)
  assert.equal(fetcher.upstreamCalls[1].body.model, 'mimo-v2.5-pro-ultraspeed')
})

test('X-TM-Speed without published speedModel falls back; only the billing pre-flight reads Firestore', async () => {
  const fetcher = speedFetcher({ plan: 'pro' })
  const res = await handleRequest(speedRequest(), env(), { fetcher })

  assert.equal(res.status, 200)
  // 1 = pré-voo de billing (shadow). O speed NÃO custa uma leitura extra —
  // a elegibilidade deriva do mesmo estado cacheado.
  assert.equal(fetcher.planCalls.length, 1)
  assert.equal(fetcher.upstreamCalls[0].body.model, activeConfig.model)
  assert.equal(res.headers.get('x-tm-speed-applied'), 'false')
})

test('speedModel published but X-TM-Speed absent keeps the active model', async () => {
  const fetcher = speedFetcher({ plan: 'pro' })
  const res = await handleRequest(
    request(),
    env({ ACTIVE_AI_CONFIG_JSON: SPEED_CONFIG_JSON }),
    { fetcher },
  )

  assert.equal(res.status, 200)
  // 1 = pré-voo de billing; nenhuma leitura adicional para o speed.
  assert.equal(fetcher.planCalls.length, 1)
  assert.equal(fetcher.upstreamCalls[0].body.model, activeConfig.model)
  assert.equal(res.headers.get('x-tm-model'), activeConfig.model)
  assert.equal(res.headers.get('x-tm-speed-applied'), 'false')
})

test('body is preserved except for model injection and stream_options.include_usage', async () => {
  const body = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'keep' }] }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    stream: true,
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 1234,
    reasoning: { enabled: true },
    thinking: { type: 'enabled' },
  }
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  await handleRequest(request('/v1/chat/completions', body), env(), { fetcher })

  // stream_options.include_usage garante o objeto `usage` no chunk final —
  // fonte autoritativa do billing. Só é injetado quando stream: true e o
  // cliente não definiu stream_options próprio.
  assert.deepEqual(fetcher.calls[0].body, {
    ...body,
    model: activeConfig.model,
    stream_options: { include_usage: true },
  })
})

test('DashScope explicit prompt cache is applied for Kimi K2.7 Code', async () => {
  const dashscopeConfig = {
    ...activeConfig,
    provider: 'dashscope',
    model: 'kimi-k2.7-code',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
  }
  const staticPart = 'S'.repeat(5000)
  const dynamicPart = 'dynamic project context'
  const fetcher = fakeFetcher(Response.json({ ok: true }))

  await handleRequest(
    request('/v1/chat/completions', {
      messages: [
        {
          role: 'system',
          content: `${staticPart}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${dynamicPart}`,
        },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
    }),
    env({
      ACTIVE_AI_CONFIG_JSON: JSON.stringify(dashscopeConfig),
      DASHSCOPE_API_KEY: 'dashscope-secret',
    }),
    { fetcher },
  )

  const system = fetcher.calls[0].body.messages[0]
  assert.equal(Array.isArray(system.content), true)
  assert.deepEqual(system.content[0].cache_control, { type: 'ephemeral' })
  assert.equal(system.content[0].text, staticPart)
  assert.equal(system.content[1].text, dynamicPart)
})

test('emits X-Model-Max-Output-Tokens when the active config declares it', async () => {
  // Auditoria 2026-07-28: a janela tinha header, o teto de SAÍDA não — um
  // modelo novo publicado só no KV herdava o teto do perfil de fallback da IDE
  // (32K) e ficava calado aí, mesmo sendo capaz de gerar muito mais.
  const fetcher = fakeFetcher(Response.json({ ok: true }))

  const res = await handleRequest(
    request('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }),
    env({
      ACTIVE_AI_CONFIG_JSON: JSON.stringify({
        ...activeConfig,
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
      }),
    }),
    { fetcher },
  )

  assert.equal(res.headers.get('x-model-max-output-tokens'), '131072')
  assert.equal(res.headers.get('x-model-context-window'), '1000000')
  assert.match(
    res.headers.get('access-control-expose-headers') ?? '',
    /X-Model-Max-Output-Tokens/,
  )
})

test('omits X-Model-Max-Output-Tokens when the config does not declare it', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))

  const res = await handleRequest(
    request('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }),
    env({ ACTIVE_AI_CONFIG_JSON: JSON.stringify(activeConfig) }),
    { fetcher },
  )

  // Ausente → a IDE cai no perfil local, como antes.
  assert.equal(res.headers.get('x-model-max-output-tokens'), null)
})

test('DashScope explicit cache applies to a MARKER-LESS system message (post-FASE-B)', async () => {
  // Auditoria 2026-07-28: the IDE stopped emitting the boundary marker when the
  // split moved to build time, so "no marker" became the normal case — and the
  // old `continue` made explicit caching dead for every DashScope model.
  const dashscopeConfig = {
    ...activeConfig,
    provider: 'dashscope',
    model: 'kimi-k2.7-code',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
  }
  const systemPrompt = 'S'.repeat(5000)
  const fetcher = fakeFetcher(Response.json({ ok: true }))

  await handleRequest(
    request('/v1/chat/completions', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
    }),
    env({
      ACTIVE_AI_CONFIG_JSON: JSON.stringify(dashscopeConfig),
      DASHSCOPE_API_KEY: 'dashscope-secret',
    }),
    { fetcher },
  )

  const system = fetcher.calls[0].body.messages[0]
  assert.equal(Array.isArray(system.content), true)
  assert.deepEqual(system.content[0].cache_control, { type: 'ephemeral' })
  assert.equal(system.content[0].text, systemPrompt)
  assert.equal(system.content.length, 1)
})

test('DashScope marker-less system stays a plain string below the cache minimum', async () => {
  const dashscopeConfig = {
    ...activeConfig,
    provider: 'dashscope',
    model: 'kimi-k2.7-code',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
  }
  const fetcher = fakeFetcher(Response.json({ ok: true }))

  await handleRequest(
    request('/v1/chat/completions', {
      messages: [{ role: 'system', content: 'short system' }],
      stream: true,
    }),
    env({
      ACTIVE_AI_CONFIG_JSON: JSON.stringify(dashscopeConfig),
      DASHSCOPE_API_KEY: 'dashscope-secret',
    }),
    { fetcher },
  )

  assert.equal(fetcher.calls[0].body.messages[0].content, 'short system')
})

test('DashScope GLM-5.2 managed path uses implicit cache shape without cache_control', async () => {
  const dashscopeConfig = {
    ...activeConfig,
    provider: 'dashscope',
    model: 'glm-5.2',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
  }
  const fetcher = fakeFetcher(Response.json({ ok: true }))

  await handleRequest(
    request('/v1/chat/completions', {
      messages: [
        { role: 'system', content: `static${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic` },
      ],
      stream: true,
    }),
    env({
      ACTIVE_AI_CONFIG_JSON: JSON.stringify(dashscopeConfig),
      DASHSCOPE_API_KEY: 'dashscope-secret',
    }),
    { fetcher },
  )

  const system = fetcher.calls[0].body.messages[0]
  assert.equal(system.content, 'static\n\ndynamic')
})

test('DashScope Kimi K2.7 Code managed path routes through compatible-mode unchanged', async () => {
  const dashscopeConfig = {
    ...activeConfig,
    provider: 'dashscope',
    model: 'kimi-k2.7-code',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    contextWindow: 262_144,
  }
  const fetcher = fakeFetcher(Response.json({ ok: true }))

  const res = await handleRequest(
    request('/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }),
    env({
      ACTIVE_AI_CONFIG_JSON: JSON.stringify(dashscopeConfig),
      DASHSCOPE_API_KEY: 'dashscope-secret',
    }),
    { fetcher },
  )

  assert.equal(res.status, 200)
  assert.equal(String(fetcher.calls[0].input), 'https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions')
  assert.equal(fetcher.calls[0].headers.get('authorization'), 'Bearer dashscope-secret')
  assert.equal(fetcher.calls[0].body.model, 'kimi-k2.7-code')
  assert.deepEqual(fetcher.calls[0].body.stream_options, { include_usage: true })
  assert.equal(res.headers.get('x-tm-model'), 'kimi-k2.7-code')
  assert.equal(res.headers.get('x-model-context-window'), '262144')
})

test('non-streaming bodies do not get stream_options injected', async () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], stream: false }
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  await handleRequest(request('/v1/chat/completions', body), env(), { fetcher })

  assert.equal(fetcher.calls[0].body.stream_options, undefined)
})

test('config extraBody is merged without overriding client fields', async () => {
  const config = { ...activeConfig, extraBody: { enable_search: true, temperature: 0.9 } }
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  await handleRequest(
    request('/v1/chat/completions', { messages: [], temperature: 0.2 }),
    env({ ACTIVE_AI_CONFIG_JSON: JSON.stringify(config) }),
    { fetcher },
  )

  // enable_search injetado (pesquisa nativa Qwen/DashScope)…
  assert.equal(fetcher.calls[0].body.enable_search, true)
  // …mas temperature do CLIENTE vence sobre o extraBody.
  assert.equal(fetcher.calls[0].body.temperature, 0.2)
})

test('X-TM-Reasoning-Effort is applied as reasoning_effort and overrides extraBody', async () => {
  const config = {
    ...activeConfig,
    provider: 'dashscope',
    model: 'glm-5.2',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    extraBody: { reasoning_effort: 'max', enable_thinking: false },
  }
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const req = request('/v1/chat/completions', { messages: [{ role: 'user', content: '1+1' }] })
  req.headers.set('X-TM-Reasoning-Effort', 'high')
  await handleRequest(req, env({ ACTIVE_AI_CONFIG_JSON: JSON.stringify(config) }), { fetcher })

  assert.equal(fetcher.calls[0].body.reasoning_effort, 'high')
  // DashScope: enable_thinking must follow effort (priority over reasoning_effort).
  assert.equal(fetcher.calls[0].body.enable_thinking, true)
  // Header never forwarded upstream (x-tm-* strip).
  assert.equal(fetcher.calls[0].headers.get('x-tm-reasoning-effort'), null)
})

test('X-TM-Reasoning-Effort none disables DashScope enable_thinking', async () => {
  const config = {
    ...activeConfig,
    provider: 'dashscope',
    model: 'glm-5.2',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    extraBody: { enable_thinking: true },
  }
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const req = request('/v1/chat/completions', { messages: [] })
  req.headers.set('X-TM-Reasoning-Effort', 'none')
  await handleRequest(req, env({ ACTIVE_AI_CONFIG_JSON: JSON.stringify(config) }), { fetcher })

  assert.equal(fetcher.calls[0].body.reasoning_effort, 'none')
  assert.equal(fetcher.calls[0].body.enable_thinking, false)
})

test('client-provided stream_options is never overwritten', async () => {
  const body = { stream: true, stream_options: { include_usage: false } }
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  await handleRequest(request('/v1/chat/completions', body), env(), { fetcher })

  assert.deepEqual(fetcher.calls[0].body.stream_options, { include_usage: false })
})

test('provider 401 is returned as 401, not custom SSE 200', async () => {
  const upstream = Response.json({ error: { message: 'invalid provider token' } }, { status: 401 })
  const res = await handleRequest(request(), env(), { fetcher: fakeFetcher(upstream) })

  assert.equal(res.status, 401)
  assert.match(await res.text(), /invalid provider token/)
})

test('provider 429 preserves Retry-After', async () => {
  const upstream = new Response('slow down', {
    status: 429,
    headers: { 'retry-after': '30', 'content-type': 'text/plain' },
  })
  const res = await handleRequest(request(), env(), { fetcher: fakeFetcher(upstream) })

  assert.equal(res.status, 429)
  assert.equal(res.headers.get('retry-after'), '30')
  assert.equal(await res.text(), 'slow down')
})

test('provider 500 is returned as 500 and no retry is attempted', async () => {
  const fetcher = fakeFetcher(new Response('provider failed', { status: 500 }))
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 500)
  assert.equal(fetcher.calls.length, 1)
  assert.equal(await res.text(), 'provider failed')
})

test('transport failure returns 502 and does not retry', async () => {
  let upstreamCalls = 0
  const fetcher = {
    async fetch(input: RequestInfo | URL) {
      // O pré-voo de billing também usa este fetcher; a falha dele degrada
      // (state null) e não conta como tentativa de upstream.
      if (String(input).includes('firestore.googleapis.com')) {
        throw new Error('firestore unavailable')
      }
      upstreamCalls += 1
      throw new Error('network failed')
    },
  }
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 502)
  assert.equal(upstreamCalls, 1)
})

test('a transient gateway HTML 400 (Tengine/DashScope) is retried then succeeds', async () => {
  let upstreamCalls = 0
  const fetcher = {
    async fetch(input: RequestInfo | URL) {
      if (String(input).includes('firestore.googleapis.com')) {
        throw new Error('firestore unavailable')
      }
      upstreamCalls += 1
      if (upstreamCalls === 1) {
        // Página HTML do gateway (rejeição transitória ANTES da API) — não é
        // o erro JSON real do provider.
        return new Response('<html><head><title>400 Bad Request</title></head></html>', {
          status: 400,
          headers: { 'content-type': 'text/html' },
        })
      }
      return Response.json({ ok: true })
    },
  }
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(upstreamCalls, 2) // 1 falha de gateway + 1 sucesso
})

test('a JSON 4xx (real API error) passes through without retry', async () => {
  let upstreamCalls = 0
  const fetcher = {
    async fetch(input: RequestInfo | URL) {
      if (String(input).includes('firestore.googleapis.com')) {
        throw new Error('firestore unavailable')
      }
      upstreamCalls += 1
      return Response.json({ error: { message: 'invalid request' } }, { status: 400 })
    },
  }
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 400)
  assert.equal(upstreamCalls, 1)
})

test('upstream that never sends headers is aborted with 504 instead of hanging', async () => {
  // O cenário do hang detector em produção: o provider aceita a ligação e
  // nunca responde. O timeout de headers aborta e devolve um 504 limpo que o
  // SDK da IDE consegue tratar — em vez de o runtime matar o pedido.
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      if (String(input).includes('firestore.googleapis.com')) return firestoreUserDoc()
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        )
      })
    },
  }

  // stream:true → usa o knob de streaming; um pedido sem stream cairia no
  // knob não-streaming (300s default) e este teste demoraria 5 minutos.
  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true }),
    env({ UPSTREAM_HEADER_TIMEOUT_MS: '25' }),
    { fetcher },
  )

  assert.equal(res.status, 504)
  assert.match(await res.text(), /tm_upstream_timeout/)
})

test('non-streaming request honours the dedicated non-stream timeout knob', async () => {
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      if (String(input).includes(':runQuery')) return Response.json([{ readTime: '2026-06-12T00:00:00Z' }])
      if (String(input).includes('firestore.googleapis.com')) return firestoreUserDoc()
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        )
      })
    },
  }

  const res = await handleRequest(
    request(), // corpo sem stream → não-streaming
    env({ UPSTREAM_NONSTREAM_HEADER_TIMEOUT_MS: '25' }),
    { fetcher },
  )

  assert.equal(res.status, 504)
  assert.match(await res.text(), /tm_upstream_timeout/)
})

test('streaming chunks are returned without worker_status, billing, or manual DONE injection', async () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'))
      controller.close()
    },
  })
  const upstream = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

  const res = await handleRequest(request('/v1/chat/completions', { stream: true, messages: [] }), env(), {
    fetcher: fakeFetcher(upstream),
  })
  const text = await res.text()

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  assert.equal(text, 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n')
  assert.doesNotMatch(text, /worker_status|billing|\[DONE\]/)
})

test('stream without DONE closes naturally and worker does not invent an event', async () => {
  const upstream = new Response('data: {"partial":true}\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
  const res = await handleRequest(request('/v1/chat/completions', { stream: true }), env(), {
    fetcher: fakeFetcher(upstream),
  })

  const text = await res.text()
  assert.equal(text, 'data: {"partial":true}\n\n')
  assert.doesNotMatch(text, /\[DONE\]|worker_status|billing/)
})

test('invalid user auth returns worker 401 and does not call upstream', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const badRequest = new Request('https://worker.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer invalid-token',
      'content-type': 'application/json',
    },
    body: '{}',
  })
  const res = await handleRequest(badRequest, env(), { fetcher })

  assert.equal(res.status, 401)
  assert.equal(fetcher.calls.length, 0)
  assert.match(await res.text(), /tm_auth_error/)
})

test('firebase_emulator auth accepts unsigned emulator JWT payload', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const emulatorRequest = new Request('https://worker.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fakeJwt({ sub: 'emulator-user', exp: Math.floor(Date.now() / 1000) + 3600 })}`,
      'content-type': 'application/json',
    },
    body: '{}',
  })

  const res = await handleRequest(emulatorRequest, env({ AUTH_MODE: 'firebase_emulator' }), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(fetcher.calls.length, 1)
})

// ── JWKS: verificação RS256 real + cache por isolate ──────────────────────

async function rs256TestToken(): Promise<{ token: string; jwk: JsonWebKey & { kid?: string } }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey & { kid?: string }
  jwk.kid = 'test-kid'

  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'RS256', kid: 'test-kid' })
  const payload = encode({
    aud: 'tm-test',
    iss: 'https://securetoken.google.com/tm-test',
    sub: 'jwks-user',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  )
  return { token: `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`, jwk }
}

function jwtRequest(token: string): Request {
  return new Request('https://worker.test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  })
}

test('firebase_jwt: JWKS is fetched once per isolate and reused across requests', async (t) => {
  clearJwksCache()
  const { token, jwk } = await rs256TestToken()

  let jwksFetches = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/jwk/')) {
      jwksFetches += 1
      return Response.json({ keys: [jwk] }, { headers: { 'cache-control': 'public, max-age=3600' } })
    }
    return originalFetch(input, init)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const testEnv = env({ AUTH_MODE: 'firebase_jwt' })

  const first = await handleRequest(jwtRequest(token), testEnv, { fetcher })
  const second = await handleRequest(jwtRequest(token), testEnv, { fetcher })

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  // Antes da cache eram 2 — um subrequest ao Google por pedido, sem timeout.
  assert.equal(jwksFetches, 1)
  assert.equal(fetcher.calls.length, 2)
})

test('firebase_jwt: JWKS unreachable without warm cache fails closed with 503', async (t) => {
  clearJwksCache()
  const { token } = await rs256TestToken()

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/jwk/')) throw new Error('network down')
    return originalFetch(input, init)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const res = await handleRequest(jwtRequest(token), env({ AUTH_MODE: 'firebase_jwt' }), { fetcher })

  assert.equal(res.status, 503)
  assert.match(await res.text(), /tm_auth_config_error/)
  assert.equal(fetcher.calls.length, 0)
})

test('client Authorization is replaced by active provider api-key', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  await handleRequest(request(), env(), { fetcher })

  assert.equal(fetcher.calls[0].headers.get('authorization'), null)
  assert.equal(fetcher.calls[0].headers.get('api-key'), 'mimo-secret')
  assert.equal(fetcher.calls[0].headers.get('cookie'), null)
  assert.equal(fetcher.calls[0].headers.get('x-tm-internal'), null)
  assert.equal(fetcher.calls[0].headers.get('cf-connecting-ip'), null)
})

test('Bearer provider key never becomes Bearer Bearer', async () => {
  const config = {
    ...activeConfig,
    provider: 'minimax',
    model: 'MiniMax-M3',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    apiKeyEnv: 'MINIMAX_API_KEY',
  }
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  await handleRequest(
    request(),
    env({
      ACTIVE_AI_CONFIG_JSON: JSON.stringify(config),
      MINIMAX_API_KEY: '"Bearer sk-test"',
    }),
    { fetcher },
  )

  assert.equal(fetcher.calls[0].headers.get('authorization'), 'Bearer sk-test')
})

test('api-key auth scheme uses api-key header and no Authorization bearer', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  await handleRequest(request(), env(), { fetcher })

  assert.equal(fetcher.calls[0].headers.get('api-key'), 'mimo-secret')
  assert.equal(fetcher.calls[0].headers.get('authorization'), null)
})

async function workerSourceFiles(): Promise<Array<{ file: string; source: string }>> {
  const srcDir = path.resolve('src')
  const names = await readdir(srcDir)
  return Promise.all(
    names
      .filter(name => name.endsWith('.ts'))
      .map(async name => ({
        file: name,
        source: await readFile(path.join(srcDir, name), 'utf8'),
      })),
  )
}

test('worker source does not import forbidden old proxy/adapters/AI SDKs', async () => {
  const files = await workerSourceFiles()
  const source = files.map(file => file.source).join('\n')

  assert.doesNotMatch(source, /proxy\.ts|billingStream|geminiAdapter|adapters\//)
  assert.doesNotMatch(source, /from ['"]openai['"]|from ['"]@anthropic-ai|from ['"]@google\/generative-ai/)
})

test('data-plane handler has no SSE parser or response TransformStream outside usage.ts', async () => {
  // usage.ts e streamWatchdog.ts são as exceções sancionadas no caminho do
  // stream: ambos identity-transforms (bytes out ≡ bytes in, nada injetado — o
  // teste de streaming acima garante isso byte a byte). usage.ts observa o
  // stream para o `usage`/billing; streamWatchdog.ts re-arma um timeout de
  // inatividade. byokCrypto.ts NÃO toca no stream — usa TextEncoder/TextDecoder
  // só para AES-GCM das chaves Team BYOK; está fora desta proibição (que é
  // sobre PARSING/MUTAÇÃO do stream SSE, a lição do proxy antigo).
  const files = await workerSourceFiles()
  const source = files
    .filter(file =>
      file.file !== 'auth.ts' &&
      file.file !== 'usage.ts' &&
      file.file !== 'streamWatchdog.ts' &&
      file.file !== 'byokCrypto.ts',
    )
    .map(file => file.source)
    .join('\n')

  assert.doesNotMatch(source, /TransformStream/)
  assert.doesNotMatch(source, /\.body\.getReader\(\)|reader\.read\(/)
  assert.doesNotMatch(source, /TextDecoder/)
  assert.doesNotMatch(source, /\.split\(['"`]\\n['"`]\)|\.split\(['"`]\\r\\n['"`]\)/)
  assert.doesNotMatch(source, /data:/)
})

// ── Billing — contabilidade autoritativa no data-plane ────────────────────

function sseUpstream(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const USAGE_CHUNK = 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n'

test('billing: budget headers carry the pre-flight state', async () => {
  // 1.25M de 1.5M (explorer) = 83% → allowed_warning.
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'explorer', tokensConsumed: 1_250_000, extraUsageBalance: 7_000 }),
  )
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-plan'), 'explorer')
  assert.equal(res.headers.get('x-budget-status'), 'allowed_warning')
  assert.equal(res.headers.get('x-tokens-consumed'), '1250000')
  assert.equal(res.headers.get('x-extra-tokens'), '7000')
  assert.equal(res.headers.get('x-cycle-end'), '2026-12-31')
  assert.ok(Math.abs(parseFloat(res.headers.get('x-budget-pct') ?? '0') - 1_250_000 / 1_500_000) < 0.001)
})

test('billing: shadow mode keeps serving a rejected user', async () => {
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'explorer', tokensConsumed: 2_000_000, extraUsageBalance: 0 }),
  )
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-budget-status'), 'rejected')
})

test('billing: enforce mode rejects an exhausted budget with 402 before the upstream call', async () => {
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'explorer', tokensConsumed: 2_000_000, extraUsageBalance: 0 }),
  )
  const res = await handleRequest(request(), env({ BUDGET_ENFORCEMENT: 'enforce' }), { fetcher })

  assert.equal(res.status, 402)
  assert.match(await res.text(), /tm_budget_exhausted/)
  assert.equal(fetcher.calls.length, 0)
})

test('suspension: blocked user is rejected with 403 before the upstream call', async () => {
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'pro', blocked: true }),
  )
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 403)
  assert.match(await res.text(), /tm_account_suspended/)
  assert.equal(fetcher.calls.length, 0) // upstream nunca foi chamado
})

test('suspension: blocked user is rejected even with billing enforcement OFF', async () => {
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'pro', blocked: true }),
  )
  const res = await handleRequest(request(), env({ BUDGET_ENFORCEMENT: 'off' }), { fetcher })

  assert.equal(res.status, 403)
  assert.match(await res.text(), /tm_account_suspended/)
  assert.equal(fetcher.calls.length, 0)
})

test('suspension: soft-deleted user is rejected with 403', async () => {
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'pro', deleted: true }),
  )
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 403)
  assert.match(await res.text(), /tm_account_suspended/)
  assert.equal(fetcher.calls.length, 0)
})

test('suspension: a non-blocked user passes the gate normally', async () => {
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'pro', blocked: false, deleted: false }),
  )
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(fetcher.calls.length, 1)
})

test('billing: tokenBudgetOverride (gift) supersedes the plan budget in the gate', async () => {
  // Gift com override 3M num explorer (plano 1.5M), consumidos 2M:
  // sem o override o gate rejeitava; com ele, 2M/3M = 67% → allowed.
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'explorer', tokensConsumed: 2_000_000, tokenBudgetOverride: 3_000_000 }),
  )
  const res = await handleRequest(request(), env({ BUDGET_ENFORCEMENT: 'enforce' }), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-budget-status'), 'allowed')
  assert.ok(Math.abs(parseFloat(res.headers.get('x-budget-pct') ?? '0') - 2 / 3) < 0.001)
})

test('billing: enforce mode lets an overage user through (extraUsageBalance > 0)', async () => {
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'explorer', tokensConsumed: 2_000_000, extraUsageBalance: 500_000 }),
  )
  const res = await handleRequest(request(), env({ BUDGET_ENFORCEMENT: 'enforce' }), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-budget-status'), 'allowed_overage')
})

test('billing: admin tokenBudget from subscription_plans supersedes the hardcoded map', async () => {
  // Cenário real (2026-06-12): admin publicou ~25.5M para o vibe, hardcoded
  // é 10.82M. User com 12M consumidos: o mapa antigo dava 402; com o budget
  // do admin é 12/25.5 = 47% → allowed.
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'vibe', tokensConsumed: 12_000_000 }),
    () => planBudgetDoc(25_500_000),
  )
  const res = await handleRequest(request(), env({ BUDGET_ENFORCEMENT: 'enforce' }), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-budget-status'), 'allowed')
  assert.ok(Math.abs(parseFloat(res.headers.get('x-budget-pct') ?? '0') - 12 / 25.5) < 0.001)
  // A query foi mesmo a subscription_plans filtrada por planKey.
  assert.equal(fetcher.planQueryCalls.length, 1)
  const q = fetcher.planQueryCalls[0].body.structuredQuery
  assert.equal(q.from[0].collectionId, 'subscription_plans')
  assert.equal(q.where.fieldFilter.value.stringValue, 'vibe')
})

test('billing: plan budget falls back to the hardcoded map when the admin doc is missing', async () => {
  // runQuery sem documento (default do fakeFetcher) → explorer mantém 1.5M
  // e 2M consumidos continuam a dar 402, como nos testes históricos.
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'explorer', tokensConsumed: 2_000_000 }),
  )
  const res = await handleRequest(request(), env({ BUDGET_ENFORCEMENT: 'enforce' }), { fetcher })

  assert.equal(res.status, 402)
  assert.equal(fetcher.planQueryCalls.length, 1)
})

test('billing: plan budget read is cached across consecutive requests', async () => {
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'vibe', tokensConsumed: 1_000 }),
    () => planBudgetDoc(25_500_000),
  )
  const testEnv = env({ BUDGET_ENFORCEMENT: 'enforce' })

  await handleRequest(request(), testEnv, { fetcher })
  await handleRequest(request(), testEnv, { fetcher })

  assert.equal(fetcher.planQueryCalls.length, 1)
  assert.equal(fetcher.calls.length, 2)
})

test('billing: usage from the final SSE chunk is committed as an atomic increment', async () => {
  const fetcher = fakeFetcher(sseUpstream([
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    USAGE_CHUNK,
    'data: [DONE]\n\n',
  ]))
  const { tasks, ctx } = collectorCtx()

  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true, messages: [] }),
    env(),
    { fetcher, ctx },
  )
  await res.text() // drena o stream (dispara o flush do observador)
  await Promise.all(tasks)

  const commits = fetcher.firestoreCalls.filter(c => c.method === 'POST')
  assert.equal(commits.length, 1)
  const transforms = commits[0].body.writes[0].transform.fieldTransforms
  assert.equal(transforms[0].fieldPath, 'tokenBudget.tokensConsumed')
  assert.equal(transforms[0].increment.integerValue, '150') // 100 + 50, 1x
  // Contador vitalício cresce a par do tokensConsumed do ciclo (mesmo valor),
  // mas vive no topo do doc para sobreviver aos resets de ciclo.
  assert.equal(transforms[1].fieldPath, 'lifetimeTokensConsumed')
  assert.equal(transforms[1].increment.integerValue, '150')
})

test('billing: the streamed bytes reaching the client are identical with usage capture on', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
    USAGE_CHUNK,
  ]
  const fetcher = fakeFetcher(sseUpstream(chunks))
  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true }),
    env(),
    { fetcher },
  )

  assert.equal(await res.text(), chunks.join(''))
})

test('billing: TM Speed served applies the 3x multiplier server-side', async () => {
  const { tasks, ctx } = collectorCtx()
  const upstreamResponse = () => sseUpstream([USAGE_CHUNK])
  const fetcher = {
    firestoreCalls: [] as Array<{ method: string; body: any }>,
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input)
      if (url.includes(':runQuery')) {
        return Response.json([{ readTime: '2026-06-12T00:00:00Z' }])
      }
      if (url.includes('firestore.googleapis.com')) {
        const method = init?.method ?? 'GET'
        this.firestoreCalls.push({
          method,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        })
        if (method === 'POST') return Response.json({ writeResults: [] })
        return firestoreUserDoc({ plan: 'pro' })
      }
      return upstreamResponse()
    },
  }

  const res = await handleRequest(
    speedRequest({ stream: true }),
    env({ ACTIVE_AI_CONFIG_JSON: SPEED_CONFIG_JSON }),
    { fetcher, ctx },
  )
  assert.equal(res.headers.get('x-tm-speed-applied'), 'true')
  await res.text()
  await Promise.all(tasks)

  const commits = fetcher.firestoreCalls.filter(c => c.method === 'POST')
  assert.equal(commits.length, 1)
  const transforms = commits[0].body.writes[0].transform.fieldTransforms
  assert.equal(transforms[0].increment.integerValue, '450') // (100+50) × 3
})

test('billing: overage commit decrements extraUsageBalance and floors it at 0', async () => {
  const fetcher = fakeFetcher(
    sseUpstream([USAGE_CHUNK]),
    () => firestoreUserDoc({ plan: 'explorer', tokensConsumed: 2_000_000, extraUsageBalance: 500_000 }),
  )
  const { tasks, ctx } = collectorCtx()

  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true }),
    env(),
    { fetcher, ctx },
  )
  await res.text()
  await Promise.all(tasks)

  const commits = fetcher.firestoreCalls.filter(c => c.method === 'POST')
  assert.equal(commits.length, 1)
  const writes = commits[0].body.writes
  const transforms = writes[0].transform.fieldTransforms
  assert.equal(transforms[0].fieldPath, 'tokenBudget.tokensConsumed')
  // Vitalício cresce SEMPRE (também em overage) — segue o tokensConsumed.
  assert.equal(transforms[1].fieldPath, 'lifetimeTokensConsumed')
  assert.equal(transforms[1].increment.integerValue, '150')
  assert.equal(transforms[2].fieldPath, 'tokenBudget.extraUsageBalance')
  assert.equal(transforms[2].increment.integerValue, '-150')
  // overageConsumed rastreia o overage pago — input do carry-over no reset
  // de ciclo (não cobrar duas vezes o excedente já pago via saldo extra).
  assert.equal(transforms[3].fieldPath, 'tokenBudget.overageConsumed')
  assert.equal(transforms[3].increment.integerValue, '150')
  // Floor a 0 como transform separado, depois do increment.
  assert.equal(writes[1].transform.fieldTransforms[0].fieldPath, 'tokenBudget.extraUsageBalance')
  assert.equal(writes[1].transform.fieldTransforms[0].maximum.integerValue, '0')
})

test('billing: provider without usage falls back to a byte estimate (never zero)', async () => {
  const fetcher = fakeFetcher(sseUpstream([
    'data: {"choices":[{"delta":{"content":"abcdef"}}]}\n\n',
  ]))
  const { tasks, ctx } = collectorCtx()

  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    env(),
    { fetcher, ctx },
  )
  await res.text()
  await Promise.all(tasks)

  const commits = fetcher.firestoreCalls.filter(c => c.method === 'POST')
  assert.equal(commits.length, 1)
  const committed = parseInt(commits[0].body.writes[0].transform.fieldTransforms[0].increment.integerValue, 10)
  assert.ok(committed > 0)
})

test('billing: sem service account contra Firestore real → billing desliga (sem 403 spam)', () => {
  // wrangler dev sem secrets no .dev.vars: o user-token path é negado pelas
  // rules fechadas + App Check → em vez de um 403 por pedido, o billing
  // resolve para 'off' com um warn único. Testes (test_static), emulador
  // (firebase_emulator/FIRESTORE_REST_BASE) e produção (SA presente)
  // mantêm o modo configurado.
  resetBillingDisabledWarning()

  // Firestore real + sem SA → off, independentemente do configurado.
  assert.equal(resolveEnforcementMode({ AUTH_MODE: 'firebase_jwt', BUDGET_ENFORCEMENT: 'enforce' }), 'off')
  assert.equal(resolveEnforcementMode({ AUTH_MODE: 'firebase_jwt' }), 'off')

  // SA presente → modo configurado.
  assert.equal(resolveEnforcementMode({
    AUTH_MODE: 'firebase_jwt',
    BUDGET_ENFORCEMENT: 'enforce',
    FIREBASE_CLIENT_EMAIL: 'sa@test.iam',
    FIREBASE_PRIVATE_KEY: 'k',
  }), 'enforce')

  // test_static / emulador (REST_BASE) → user-token path utilizável → modo configurado.
  assert.equal(resolveEnforcementMode({ AUTH_MODE: 'test_static' }), 'shadow')
  assert.equal(resolveEnforcementMode({ FIRESTORE_REST_BASE: 'http://127.0.0.1:8082' }), 'shadow')
  // AUTH_MODE=firebase_emulator SOZINHO não chega — sem REST_BASE as
  // escritas iriam para o Firestore REAL com token de emulador (403).
  assert.equal(resolveEnforcementMode({ AUTH_MODE: 'firebase_emulator' }), 'off')

  // 'off' explícito continua off.
  assert.equal(resolveEnforcementMode({ AUTH_MODE: 'test_static', BUDGET_ENFORCEMENT: 'off' }), 'off')
})

test('billing: BUDGET_ENFORCEMENT=off skips budget headers and commit (but still reads for the suspension gate)', async () => {
  const fetcher = fakeFetcher(sseUpstream([USAGE_CHUNK]))
  const { tasks, ctx } = collectorCtx()

  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true }),
    env({ BUDGET_ENFORCEMENT: 'off' }),
    { fetcher, ctx },
  )
  await res.text()
  await Promise.all(tasks)

  // Sem gate de orçamento nem commit em modo off…
  assert.equal(res.headers.get('x-budget-status'), null)
  const commits = fetcher.firestoreCalls.filter(c => c.method === 'POST')
  assert.equal(commits.length, 0)
  // …mas o doc do user É lido (uma única vez, GET) para o gate de suspensão,
  // que tem de funcionar independentemente do modo de billing.
  const reads = fetcher.firestoreCalls.filter(c => c.method === 'GET')
  assert.equal(reads.length, 1)
})

test('billing: client disconnect mid-stream still settles and commits the partial estimate', async () => {
  // Stream que nunca fecha sozinho — simula um provider a meio da geração.
  const encoder = new TextEncoder()
  let pushChunk: ((s: string) => void) | null = null
  const endless = new ReadableStream<Uint8Array>({
    start(controller) {
      pushChunk = (s: string) => controller.enqueue(encoder.encode(s))
    },
  })
  const fetcher = fakeFetcher(new Response(endless, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }))
  const { tasks, ctx } = collectorCtx()

  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    env(),
    { fetcher, ctx },
  )

  // Lê um chunk e DESLIGA (cancel) — o caminho que deixava o waitUntil
  // pendurado ("waitUntil() tasks did not complete within the allowed time")
  // e perdia o commit.
  const reader = res.body!.getReader()
  pushChunk!('data: {"choices":[{"delta":{"content":"partial output"}}]}\n\n')
  await reader.read()
  await reader.cancel()

  await Promise.all(tasks)

  const commits = fetcher.firestoreCalls.filter(c => c.method === 'POST')
  assert.equal(commits.length, 1)
  const committed = parseInt(commits[0].body.writes[0].transform.fieldTransforms[0].increment.integerValue, 10)
  assert.ok(committed > 0) // estimativa parcial — nunca zero, nunca pendurado
})

test('billing: provider errors are never billed', async () => {
  const fetcher = fakeFetcher(new Response('provider failed', { status: 500 }))
  const { tasks, ctx } = collectorCtx()

  const res = await handleRequest(request(), env(), { fetcher, ctx })
  await res.text()
  await Promise.all(tasks)

  assert.equal(res.status, 500)
  const commits = fetcher.firestoreCalls.filter(c => c.method === 'POST')
  assert.equal(commits.length, 0)
})

test('billing: pre-flight read is cached across consecutive turns', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const testEnv = env()

  await handleRequest(request(), testEnv, { fetcher })
  await handleRequest(request(), testEnv, { fetcher })

  const reads = fetcher.firestoreCalls.filter(c => c.method === 'GET')
  assert.equal(reads.length, 1)
})

// ── google_oauth (Vertex AI) ──────────────────────────────────────────────
//
// A Vertex não aceita API key estática: o apiKeyEnv aponta para o JSON da
// service account e o worker minta um access token OAuth2 por pedido (com
// cache). Estes testes assinam com uma chave RSA real gerada em memória —
// o mint usa WebCrypto a sério, só o endpoint OAuth é mockado.

const vertexPrivateKeyPem = (() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
})()

const vertexServiceAccountJson = JSON.stringify({
  client_email: 'vertex-sa@tm-test.iam.gserviceaccount.com',
  private_key: vertexPrivateKeyPem,
})

const vertexActiveConfig = {
  provider: 'gemini',
  model: 'google/gemini-3.5-flash',
  baseUrl: 'https://aiplatform.googleapis.com/v1/projects/tm-test/locations/global/endpoints/openapi',
  chatCompletionsPath: '/chat/completions',
  authHeader: 'Authorization',
  authScheme: 'google_oauth',
  apiKeyEnv: 'VERTEX_AI_SERVICE_ACCOUNT_JSON',
  enabled: true,
}

/** Fetcher que distingue OAuth, Firestore e upstream Vertex. */
function vertexFetcher(opts: { oauthResponse?: () => Response; upstreamResponse?: () => Response } = {}) {
  const oauthCalls: Array<{ body: string }> = []
  const upstreamCalls: Array<{ input: RequestInfo | URL; body: any; headers: Headers }> = []
  return {
    oauthCalls,
    upstreamCalls,
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com')) {
        oauthCalls.push({ body: String(init?.body) })
        return opts.oauthResponse
          ? opts.oauthResponse()
          : Response.json({ access_token: 'vertex-access-token', expires_in: 3600 })
      }
      if (url.includes(':runQuery')) {
        return Response.json([{ readTime: '2026-06-12T00:00:00Z' }])
      }
      if (url.includes('firestore.googleapis.com')) {
        if ((init?.method ?? 'GET') === 'POST') return Response.json({ writeResults: [] })
        return firestoreUserDoc()
      }
      upstreamCalls.push({
        input,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        headers: new Headers(init?.headers),
      })
      return opts.upstreamResponse ? opts.upstreamResponse() : Response.json({ ok: true })
    },
  }
}

function vertexEnv(overrides: Partial<Env> = {}): Env {
  return env({
    ACTIVE_AI_CONFIG_JSON: JSON.stringify(vertexActiveConfig),
    VERTEX_AI_SERVICE_ACCOUNT_JSON: vertexServiceAccountJson,
    ...overrides,
  })
}

test('google_oauth: mints an OAuth token and sends it as Bearer upstream', async () => {
  const fetcher = vertexFetcher()

  const res = await handleRequest(request(), vertexEnv(), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(fetcher.oauthCalls.length, 1)
  // O JWT assinado pede o scope cloud-platform (Vertex), não datastore —
  // o scope vive no payload base64url da assertion, não no corpo urlencoded.
  const assertion = new URLSearchParams(fetcher.oauthCalls[0].body).get('assertion') ?? ''
  const jwtPayload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString())
  assert.equal(jwtPayload.scope, 'https://www.googleapis.com/auth/cloud-platform')
  assert.equal(fetcher.upstreamCalls.length, 1)
  const call = fetcher.upstreamCalls[0]
  assert.equal(
    String(call.input),
    'https://aiplatform.googleapis.com/v1/projects/tm-test/locations/global/endpoints/openapi/chat/completions',
  )
  assert.equal(call.headers.get('authorization'), 'Bearer vertex-access-token')
  // O modelo publicado leva o prefixo de publisher exigido pela Vertex.
  assert.equal(call.body.model, 'google/gemini-3.5-flash')
})

test('google_oauth: token is cached across consecutive requests', async () => {
  const fetcher = vertexFetcher()
  const testEnv = vertexEnv()

  await handleRequest(request(), testEnv, { fetcher })
  await handleRequest(request(), testEnv, { fetcher })

  assert.equal(fetcher.oauthCalls.length, 1)
  assert.equal(fetcher.upstreamCalls.length, 2)
})

test('google_oauth: missing/invalid service account JSON → 500 tm_provider_secret_missing', async () => {
  for (const value of [undefined, '', 'not-json', '{"client_email":"x"}']) {
    clearActiveConfigCache()
    const fetcher = vertexFetcher()
    const res = await handleRequest(
      request(),
      vertexEnv({ VERTEX_AI_SERVICE_ACCOUNT_JSON: value }),
      { fetcher },
    )
    assert.equal(res.status, 500)
    const body = await res.json() as { error: { type: string } }
    assert.equal(body.error.type, 'tm_provider_secret_missing')
    assert.equal(fetcher.upstreamCalls.length, 0)
  }
})

test('google_oauth: OAuth exchange failure → 502 tm_provider_auth_failed, upstream never called', async () => {
  const fetcher = vertexFetcher({ oauthResponse: () => new Response('denied', { status: 403 }) })

  const res = await handleRequest(request(), vertexEnv(), { fetcher })

  assert.equal(res.status, 502)
  const body = await res.json() as { error: { type: string } }
  assert.equal(body.error.type, 'tm_provider_auth_failed')
  assert.equal(fetcher.upstreamCalls.length, 0)
})

// ── Timeout de headers por tipo de pedido ─────────────────────────────────

test('header timeout: streaming 120s default, non-streaming 300s default, env overrides respected', async () => {
  const { resolveUpstreamHeaderTimeout } = await import('../src/index')

  assert.equal(resolveUpstreamHeaderTimeout({} as Env, true), 120_000)
  assert.equal(resolveUpstreamHeaderTimeout({} as Env, false), 300_000)
  assert.equal(
    resolveUpstreamHeaderTimeout({ UPSTREAM_HEADER_TIMEOUT_MS: '60000' } as Env, true),
    60_000,
  )
  assert.equal(
    resolveUpstreamHeaderTimeout({ UPSTREAM_NONSTREAM_HEADER_TIMEOUT_MS: '600000' } as Env, false),
    600_000,
  )
  // Knob de um tipo não contamina o outro.
  assert.equal(
    resolveUpstreamHeaderTimeout({ UPSTREAM_HEADER_TIMEOUT_MS: '60000' } as Env, false),
    300_000,
  )
  // Valores inválidos caem no default.
  assert.equal(resolveUpstreamHeaderTimeout({ UPSTREAM_HEADER_TIMEOUT_MS: 'abc' } as Env, true), 120_000)
})

// ── Sidecars por X-Request-Type ───────────────────────────────────────────

const utilitySidecarConfig = {
  provider: 'dashscope',
  model: 'qwen3.7-plus',
  baseUrl: 'https://sidecar.test/v1',
  chatCompletionsPath: '/chat/completions',
  authHeader: 'Authorization',
  authScheme: 'Bearer',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  enabled: true,
}

function kvEnv(sidecars: Record<string, string>, overrides: Partial<Env> = {}): Env {
  return env({
    DASHSCOPE_API_KEY: 'dash-secret',
    ACTIVE_AI_CONFIG: {
      get: async (key: string) =>
        key === 'active' ? JSON.stringify(activeConfig) : (sidecars[key] ?? null),
    },
    ...overrides,
  })
}

function typedRequest(requestType: string) {
  return new Request('https://worker.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-user-token',
      'content-type': 'application/json',
      'x-request-type': requestType,
    },
    body: JSON.stringify({ messages: [] }),
  })
}

test('sidecar: X-Request-Type web_search routes to the published sidecar config', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const res = await handleRequest(
    typedRequest('web_search'),
    kvEnv({ 'sidecar:web_search': JSON.stringify(utilitySidecarConfig) }),
    { fetcher },
  )

  assert.equal(res.status, 200)
  assert.equal(String(fetcher.calls[0].input), 'https://sidecar.test/v1/chat/completions')
  assert.equal(fetcher.calls[0].body.model, 'qwen3.7-plus')
  assert.equal(fetcher.calls[0].headers.get('authorization'), 'Bearer dash-secret')
  // O cliente distingue quem serviu pelo X-TM-Config-Key.
  assert.equal(res.headers.get('x-tm-config-key'), 'sidecar:web_search')
  assert.equal(res.headers.get('x-tm-model'), 'qwen3.7-plus')
})

test('sidecar: memory/planner/router and summarize share the utility sidecar', async () => {
  for (const type of ['memory-extractor', 'memory-selector', 'memory-distiller', 'summarize', 'intent-router', 'context-planner']) {
    clearActiveConfigCache()
    const fetcher = fakeFetcher(Response.json({ ok: true }))
    const res = await handleRequest(
      typedRequest(type),
      kvEnv({ 'sidecar:utility': JSON.stringify(utilitySidecarConfig) }),
      { fetcher },
    )
    assert.equal(res.headers.get('x-tm-config-key'), 'sidecar:utility', type)
  }
})

test('sidecar: unpublished strict sidecar (vision/web_search/fim/context-planner) returns 503 without an upstream call', async () => {
  // Degradar visão/pesquisa/FIM para o modelo ativo GERAL produz 404 (imagem a
  // modelo de texto), alucinação (pesquisa sem motor) ou lixo (FIM sem template).
  // O context-planner exige JSON; degradar para active mascara o erro e devolve
  // prosa ao parser. O worker falha já com 503 e o cliente usa fallback de código.
  for (const type of ['vision', 'web_search', 'fim', 'context-planner']) {
    clearActiveConfigCache()
    const fetcher = fakeFetcher(Response.json({ ok: true }))
    const res = await handleRequest(typedRequest(type), kvEnv({}), { fetcher })

    assert.equal(res.status, 503, type)
    assert.match(await res.text(), /tm_sidecar_unavailable/, type)
    assert.equal(fetcher.calls.length, 0, type)
  }
})

test('sidecar: invalid or disabled specialized sidecar returns 503 (never degrades to active)', async () => {
  for (const bad of ['not-json', JSON.stringify({ ...utilitySidecarConfig, enabled: false })]) {
    clearActiveConfigCache()
    const fetcher = fakeFetcher(Response.json({ ok: true }))
    const res = await handleRequest(
      typedRequest('vision'),
      kvEnv({ 'sidecar:vision': bad }),
      { fetcher },
    )
    assert.equal(res.status, 503)
    assert.equal(fetcher.calls.length, 0)
  }
})

test('sidecar: utility/summarize WITHOUT a published sidecar still degrades to active', async () => {
  // Ao contrário de vision/web_search/fim, o modelo ativo SABE resumir/extrair,
  // por isso os tipos utility degradam para a config ativa em vez de 503.
  for (const type of ['summarize', 'memory-extractor']) {
    clearActiveConfigCache()
    const fetcher = fakeFetcher(Response.json({ ok: true }))
    const res = await handleRequest(typedRequest(type), kvEnv({}), { fetcher })
    assert.equal(res.status, 200, type)
    assert.equal(String(fetcher.calls[0].input), 'https://provider.test/v1/chat/completions', type)
    assert.equal(res.headers.get('x-tm-config-key'), 'active', type)
  }
})

test('sidecar: unknown request types never consult the KV sidecar namespace', async () => {
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  const res = await handleRequest(typedRequest('totally-unknown'), kvEnv({}), { fetcher })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-tm-config-key'), 'active')
})

// ── Plano de Equipas — fatia hard-cap partilhada ──────────────────────────
//
// Membro com users/{uid}.activeTeamId consome da FATIA dele numa equipa, não
// do plano pessoal. pie = budget base do tier + purchasedExtra; teto =
// percentAllocation × pie. Hard cap ESTRITO: 100% da fatia → rejected, sem
// overage, mesmo com folga na equipa. Commit é dual-write no doc da equipa.

/** teams/{id} para os mocks: tier + purchasedExtra + submapa members.{uid}. */
function firestoreTeamDoc(opts: {
  planTier?: string
  purchasedExtra?: number
  cycleEnd?: string
  percentAllocation?: number
  memberConsumed?: number
  byokTeamConsumed?: number
  byokMemberConsumed?: number
  memberBlocked?: boolean
  subscriptionActive?: boolean
  uid?: string
} = {}): Response {
  const uid = opts.uid ?? 'test-user' // test_static → userId === 'test-user'
  return Response.json({
    fields: {
      planTier: { stringValue: opts.planTier ?? 'team-pro' },
      subscription: { mapValue: { fields: {
        active: { booleanValue: opts.subscriptionActive ?? true },
        expiresAt: { stringValue: '2099-12-31T00:00:00Z' },
      } } },
      tokenBudget: { mapValue: { fields: {
        purchasedExtra: { integerValue: String(opts.purchasedExtra ?? 0) },
      } } },
      ...(opts.byokTeamConsumed !== undefined ? {
        byokBudget: { mapValue: { fields: {
          consumed: { integerValue: String(opts.byokTeamConsumed) },
        } } },
      } : {}),
      cycle: { mapValue: { fields: {
        cycleEnd: { stringValue: opts.cycleEnd ?? '2026-12-31' },
      } } },
      members: { mapValue: { fields: {
        [uid]: { mapValue: { fields: {
          percentAllocation: { doubleValue: opts.percentAllocation ?? 0 },
          tokensConsumed: { integerValue: String(opts.memberConsumed ?? 0) },
          ...(opts.byokMemberConsumed !== undefined ? { byokConsumed: { integerValue: String(opts.byokMemberConsumed) } } : {}),
          ...(opts.memberBlocked !== undefined ? { blocked: { booleanValue: opts.memberBlocked } } : {}),
        } } },
      } } },
    },
  })
}

/** users/{uid} com activeTeamId — dispara o caminho de equipa no pré-voo. */
function firestoreTeamUserDoc(teamId = 'team-1', opts: { blocked?: boolean; deleted?: boolean } = {}): Response {
  return Response.json({
    fields: {
      activeTeamId: { stringValue: teamId },
      ...(opts.blocked !== undefined ? { blocked: { booleanValue: opts.blocked } } : {}),
      ...(opts.deleted !== undefined ? { deleted: { booleanValue: opts.deleted } } : {}),
    },
  })
}

/**
 * Fetcher de equipa: GET a users/{uid} → doc com activeTeamId; GET a teams/{id}
 * → doc da equipa; :runQuery (budget do tier) e commit (POST) como no
 * fakeFetcher. O pré-voo de um membro custa 2 GETs (user + team).
 */
function teamFetcher(opts: {
  upstream?: Response
  userDoc?: () => Response
  teamDoc?: () => Response
  planDoc?: () => Response
} = {}) {
  const calls: Array<{ input: RequestInfo | URL; body: any; headers: Headers }> = []
  const firestoreCalls: Array<{ input: RequestInfo | URL; method: string; body: any }> = []
  const planQueryCalls: Array<{ body: any }> = []
  return {
    calls,
    firestoreCalls,
    planQueryCalls,
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
      if (url.includes(':runQuery')) {
        planQueryCalls.push({ body })
        return opts.planDoc ? opts.planDoc() : Response.json([{ readTime: '2026-06-12T00:00:00Z' }])
      }
      if (url.includes('firestore.googleapis.com')) {
        firestoreCalls.push({ input, method, body })
        if (method === 'POST') return Response.json({ writeResults: [] })
        if (url.includes('/documents/teams/')) return (opts.teamDoc ?? firestoreTeamDoc)()
        return (opts.userDoc ?? (() => firestoreTeamUserDoc()))()
      }
      calls.push({ input, body, headers: new Headers(init?.headers) })
      return opts.upstream ?? Response.json({ ok: true })
    },
  }
}

test('team: budget headers reflect the member slice (pie × allocation), at the cost of 2 reads', async () => {
  // tier team-pro fallback 20.91M, sem extra. Fatia 50% = 10.455M.
  // Consumido 8.364M = 80% → allowed_warning.
  const fetcher = teamFetcher({
    teamDoc: () => firestoreTeamDoc({ planTier: 'team-pro', percentAllocation: 0.5, memberConsumed: 8_364_000 }),
  })
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-plan'), 'pro') // H4: tier team-pro → plano-base 'pro'
  assert.equal(res.headers.get('x-budget-status'), 'allowed_warning')
  assert.equal(res.headers.get('x-tokens-consumed'), '8364000')
  assert.equal(res.headers.get('x-extra-tokens'), '0') // membro não tem overage pessoal
  assert.ok(Math.abs(parseFloat(res.headers.get('x-budget-pct') ?? '0') - 0.8) < 0.001)
  // §3.5: headers de contexto de equipa para a IDE enquadrar fatia/bolo.
  assert.equal(res.headers.get('x-team-id'), 'team-1')
  assert.equal(res.headers.get('x-team-tier'), 'team-pro')
  assert.equal(res.headers.get('x-slice-tokens'), '10455000') // 50% × 20.91M
  assert.equal(res.headers.get('x-pie-total'), '20910000')
  // Pré-voo do membro = 2 GETs (users/{uid} + teams/{id}).
  assert.equal(fetcher.firestoreCalls.filter(c => c.method === 'GET').length, 2)
})

test('team: exhausted slice is rejected with 402 even if the team pool has headroom', async () => {
  // Fatia 10% de 20.91M = 2.091M; consumido 2.091M = 100% → rejected. A equipa
  // tem 90% por usar, mas o hard cap é estrito — só o admin a subir a % desbloqueia.
  const fetcher = teamFetcher({
    teamDoc: () => firestoreTeamDoc({ percentAllocation: 0.1, memberConsumed: 2_091_000 }),
  })
  const res = await handleRequest(request(), env({ BUDGET_ENFORCEMENT: 'enforce' }), { fetcher })

  assert.equal(res.status, 402)
  // Código dedicado (§3.2) → a IDE mostra "fala com o teu admin" em vez de comprar.
  assert.match(await res.text(), /tm_team_slice_exhausted/)
  assert.equal(fetcher.calls.length, 0) // upstream nunca chamado
})

test('team: slice exhaustion blocks even in SHADOW mode (feature nova, sem legados)', async () => {
  // Pessoal em shadow só mede; equipa bloqueia já — o hard cap é o contrato da
  // feature e não há equipas legadas a proteger.
  const fetcher = teamFetcher({
    teamDoc: () => firestoreTeamDoc({ percentAllocation: 0.1, memberConsumed: 2_091_000 }),
  })
  const res = await handleRequest(request(), env(), { fetcher }) // default = shadow

  assert.equal(res.status, 402)
  assert.match(await res.text(), /tm_team_slice_exhausted/)
  assert.equal(fetcher.calls.length, 0)
})

test('team: purchased extra grows the pie so the slice scales (no false 402)', async () => {
  // Base do tier (admin) = 10M; +3M avulsos → pie 13M; fatia 100% = 13M.
  // Consumido 12M: sem o extra (base 10M) seria 120% → rejected; com o extra,
  // 12/13 = 92% → allowed (warning, ≥80% e <95%).
  const fetcher = teamFetcher({
    teamDoc: () => firestoreTeamDoc({ percentAllocation: 1, purchasedExtra: 3_000_000, memberConsumed: 12_000_000 }),
    planDoc: () => planBudgetDoc(10_000_000),
  })
  const res = await handleRequest(request(), env({ BUDGET_ENFORCEMENT: 'enforce' }), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-budget-status'), 'allowed_warning')
  assert.ok(Math.abs(parseFloat(res.headers.get('x-budget-pct') ?? '0') - 12 / 13) < 0.001)
})

test('team: commit is an atomic dual-write to teams/{id} (total + member slice), no overage', async () => {
  const { tasks, ctx } = collectorCtx()
  const fetcher = teamFetcher({
    upstream: sseUpstream([USAGE_CHUNK]),
    teamDoc: () => firestoreTeamDoc({ percentAllocation: 0.5, memberConsumed: 1_000 }),
  })

  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true, messages: [] }),
    env(),
    { fetcher, ctx },
  )
  await res.text()
  await Promise.all(tasks)

  const commits = fetcher.firestoreCalls.filter(c => c.method === 'POST')
  assert.equal(commits.length, 1)
  const write = commits[0].body.writes[0]
  // Escreve no doc da EQUIPA, não em users/{uid}.
  assert.match(write.transform.document, /\/documents\/teams\/team-1$/)
  const t = write.transform.fieldTransforms
  assert.equal(t[0].fieldPath, 'tokenBudget.tokensConsumed')
  assert.equal(t[0].increment.integerValue, '150')
  assert.equal(t[1].fieldPath, 'lifetimeTokensConsumed')
  assert.equal(t[1].increment.integerValue, '150')
  assert.equal(t[2].fieldPath, 'members.`test-user`.tokensConsumed')
  assert.equal(t[2].increment.integerValue, '150')
  // Hard cap estrito: exatamente 3 transforms, um único write (sem extra/floor).
  assert.equal(t.length, 3)
  assert.equal(commits[0].body.writes.length, 1)
})

test('team: a blocked team member is rejected with 403 (suspension gate reused)', async () => {
  const fetcher = teamFetcher({
    teamDoc: () => firestoreTeamDoc({ percentAllocation: 0.5, memberConsumed: 0, memberBlocked: true }),
  })
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 403)
  assert.match(await res.text(), /tm_account_suspended/)
  assert.equal(fetcher.calls.length, 0)
})

test('team: stale activeTeamId (not a member) falls back to the personal plan, not 402 (M1)', async () => {
  // User com activeTeamId apontando para uma equipa onde NÃO é membro (removido,
  // activeTeamId por limpar) → cai no plano PESSOAL (explorer), não rejeitado.
  const userWithStaleTeam = () => Response.json({
    fields: {
      userPlan: { stringValue: 'explorer' },
      activeTeamId: { stringValue: 'team-1' },
      tokenBudget: { mapValue: { fields: {
        tokensConsumed: { integerValue: '100000' },
        extraUsageBalance: { integerValue: '0' },
        cycleEnd: { stringValue: '2026-12-31' },
      } } },
    },
  })
  const fetcher = teamFetcher({
    userDoc: userWithStaleTeam,
    teamDoc: () => firestoreTeamDoc({ uid: 'someone-else', percentAllocation: 1, memberConsumed: 0 }),
  })
  const res = await handleRequest(request(), env({ BUDGET_ENFORCEMENT: 'enforce' }), { fetcher })

  assert.equal(res.status, 200) // explorer 100K/1.5M = 7% → allowed (não 402)
  assert.equal(res.headers.get('x-plan'), 'explorer')
})

test('team: INACTIVE subscription gives no pie → falls back to personal (sem pie grátis)', async () => {
  // Fecha o furo: equipa sem subscrição ativa não concede o budget do tier.
  const userWithTeam = () => Response.json({
    fields: {
      userPlan: { stringValue: 'explorer' },
      activeTeamId: { stringValue: 'team-1' },
      tokenBudget: { mapValue: { fields: {
        tokensConsumed: { integerValue: '100000' },
        cycleEnd: { stringValue: '2026-12-31' },
      } } },
    },
  })
  const fetcher = teamFetcher({
    userDoc: userWithTeam,
    teamDoc: () => firestoreTeamDoc({ percentAllocation: 1, memberConsumed: 0, subscriptionActive: false }),
  })
  const res = await handleRequest(request(), env({ BUDGET_ENFORCEMENT: 'enforce' }), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-plan'), 'explorer') // plano pessoal, NÃO a pie da equipa
})

// ── Watchdog de inatividade do stream (pós-headers) ──────────────────────
// O header-timeout só cobre até ao 1º byte; este teste cobre o gémeo: o
// provider devolve 200 + headers e depois estola (stream que nunca emite nem
// fecha). Sem o watchdog a Response ficava aberta até o runtime a matar com
// "code had hung". Com ele, o upstream é abortado e o readable erra.
test('idle watchdog aborts a stalled upstream stream after headers', async () => {
  let upstreamAborted = false
  // Stream que NUNCA emite nem fecha — provider estolado pós-headers.
  const stalled = new ReadableStream<Uint8Array>({})
  const stalledResponse = new Response(stalled, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input)
      if (url.includes(':runQuery')) return planBudgetDoc(20_910_000)
      if (url.includes('firestore.googleapis.com')) return firestoreUserDoc({ plan: 'pro' })
      // Upstream do provider: regista o abort e devolve o stream estolado.
      init?.signal?.addEventListener('abort', () => { upstreamAborted = true })
      return stalledResponse
    },
  }

  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true }),
    env({ UPSTREAM_STREAM_IDLE_TIMEOUT_MS: '25' }),
    { fetcher, ctx: collectorCtx().ctx },
  )

  assert.equal(res.status, 200)
  assert.ok(res.body)
  // O readable deve errar quando o watchdog dispara (~25ms), em vez de ficar
  // pendurado para sempre.
  await assert.rejects(res.body!.getReader().read())
  assert.equal(upstreamAborted, true, 'o upstream estolado deve ser abortado pelo watchdog')
})

// O knob a 0 desliga o watchdog: um stream saudável que fecha sozinho passa
// intacto e o readable termina normalmente (sem erro espúrio).
test('idle watchdog disabled (0) lets a healthy stream complete', async () => {
  const healthy = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  const fetcher = {
    async fetch(input: RequestInfo | URL) {
      const url = String(input)
      if (url.includes(':runQuery')) return planBudgetDoc(20_910_000)
      if (url.includes('firestore.googleapis.com')) return firestoreUserDoc({ plan: 'pro' })
      return new Response(healthy, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  }

  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true }),
    env({ UPSTREAM_STREAM_IDLE_TIMEOUT_MS: '0' }),
    { fetcher, ctx: collectorCtx().ctx },
  )

  assert.equal(res.status, 200)
  const text = await res.text()
  assert.ok(text.includes('[DONE]'))
})

// ── Team BYOK (`team:{teamId}`) ──────────────────────────────────────────────

// 32-byte AES-256 key (base64) shared by both workers in prod via the
// TEAM_BYOK_ENC_KEY secret. Reuses kvEnv() (sidecar tests): its mock KV returns
// `sidecars[key] ?? null` for any non-`active` key, so a `team:{id}` entry works.
const TEST_ENC_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')

async function teamCfg(overrides: Record<string, unknown> = {}): Promise<string> {
  const apiKey = await encryptSecret('sk-team-real-key', TEST_ENC_KEY)
  return JSON.stringify({
    provider: 'dashscope',
    model: 'qwen3-max',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    chatCompletionsPath: '/chat/completions',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    apiKey, // AES-GCM ciphertext (tbk1:…)
    enabled: true,
    contextWindow: 1_000_000,
    ...overrides,
  })
}

test('team BYOK: getTeamByokConfig resolves + DECRYPTS the inline key', async () => {
  const cfg = await teamCfg()
  const resolved = await getTeamByokConfig(
    kvEnv({ 'team:T1': cfg }, { TEAM_BYOK_ENC_KEY: TEST_ENC_KEY }),
    'T1',
  )
  assert.ok(resolved, 'expected a resolved team config')
  assert.equal(resolved!.key, 'team:T1')
  assert.equal(resolved!.config.model, 'qwen3-max')
  assert.equal(resolved!.config.baseUrl, 'https://dashscope-us.aliyuncs.com/compatible-mode/v1')
  // Decrypted back to the real key for buildUpstreamHeaders.
  assert.equal(resolved!.config.apiKey, 'sk-team-real-key')
})

test('team BYOK: metered pool is shared, not capped by member allocation', async () => {
  const cfg = await teamCfg({ pool: 1_000_000 })
  const fetcher = teamFetcher({
    userDoc: () => firestoreTeamUserDoc('T1'),
    teamDoc: () => firestoreTeamDoc({
      percentAllocation: 0,
      byokTeamConsumed: 470_000,
      byokMemberConsumed: 470_000,
    }),
  })
  const res = await handleRequest(
    request(),
    kvEnv({ 'team:T1': cfg }, { TEAM_BYOK_ENC_KEY: TEST_ENC_KEY, BUDGET_ENFORCEMENT: 'enforce' }),
    { fetcher },
  )

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-tm-team-byok'), 'true')
  assert.equal(fetcher.calls.length, 1)
})

test('team BYOK: metered pool blocks only when the shared pool is exhausted', async () => {
  const cfg = await teamCfg({ pool: 1_000_000 })
  const fetcher = teamFetcher({
    userDoc: () => firestoreTeamUserDoc('T1'),
    teamDoc: () => firestoreTeamDoc({
      percentAllocation: 1,
      byokTeamConsumed: 1_000_000,
      byokMemberConsumed: 0,
    }),
  })
  const res = await handleRequest(
    request(),
    kvEnv({ 'team:T1': cfg }, { TEAM_BYOK_ENC_KEY: TEST_ENC_KEY, BUDGET_ENFORCEMENT: 'enforce' }),
    { fetcher },
  )

  assert.equal(res.status, 402)
  const body = await res.text()
  assert.match(body, /tm_team_byok_exhausted/)
  assert.doesNotMatch(body, /slice/i)
  assert.equal(fetcher.calls.length, 0)
})

test('team BYOK: missing enc key / bad ciphertext / disabled / oauth / absent → null', async () => {
  const cfg = await teamCfg()
  // TEAM_BYOK_ENC_KEY not provisioned → cannot decrypt → degrade.
  assert.equal(await getTeamByokConfig(kvEnv({ 'team:T1': cfg }), 'T1'), null)
  // Tampered/garbled ciphertext → degrade (never route with a broken key).
  const bad = JSON.stringify({ ...JSON.parse(cfg), apiKey: 'tbk1:zzz:zzz' })
  assert.equal(await getTeamByokConfig(kvEnv({ 'team:T1': bad }, { TEAM_BYOK_ENC_KEY: TEST_ENC_KEY }), 'T1'), null)
  // Disabled.
  const disabled = await teamCfg({ enabled: false })
  assert.equal(await getTeamByokConfig(kvEnv({ 'team:T1': disabled }, { TEAM_BYOK_ENC_KEY: TEST_ENC_KEY }), 'T1'), null)
  // Garbage JSON + absent key + empty teamId.
  assert.equal(await getTeamByokConfig(kvEnv({ 'team:T1': 'not json' }, { TEAM_BYOK_ENC_KEY: TEST_ENC_KEY }), 'T1'), null)
  assert.equal(await getTeamByokConfig(kvEnv({}, { TEAM_BYOK_ENC_KEY: TEST_ENC_KEY }), 'T1'), null)
  assert.equal(await getTeamByokConfig(kvEnv({ 'team:T1': cfg }, { TEAM_BYOK_ENC_KEY: TEST_ENC_KEY }), ''), null)
})

test('team BYOK: Vertex (google_oauth) resolves with the decrypted service-account JSON', async () => {
  const saJson = JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n', project_id: 'proj' })
  const enc = await encryptSecret(saJson, TEST_ENC_KEY)
  const cfg = JSON.stringify({
    provider: 'vertex',
    model: 'google/gemini-2.5-pro',
    baseUrl: 'https://us-east5-aiplatform.googleapis.com/v1beta1/projects/proj/locations/us-east5/endpoints/openapi',
    chatCompletionsPath: '/chat/completions',
    authHeader: 'Authorization',
    authScheme: 'google_oauth',
    apiKey: enc,
    enabled: true,
  })
  const resolved = await getTeamByokConfig(kvEnv({ 'team:T1': cfg }, { TEAM_BYOK_ENC_KEY: TEST_ENC_KEY }), 'T1')
  assert.ok(resolved, 'expected google_oauth team config to resolve')
  assert.equal(resolved!.config.authScheme, 'google_oauth')
  // apiKey decrypted back to the SA JSON (buildUpstreamHeaders parses it to mint).
  assert.equal(JSON.parse(resolved!.config.apiKey as string).client_email, 'svc@proj.iam.gserviceaccount.com')
})

test('byokCrypto: encrypt → decrypt round-trips; wrong key fails', async () => {
  const { decryptSecret } = await import('../src/byokCrypto')
  const blob = await encryptSecret('hunter2', TEST_ENC_KEY)
  assert.ok(blob.startsWith('tbk1:'))
  assert.equal(await decryptSecret(blob, TEST_ENC_KEY), 'hunter2')
  const otherKey = Buffer.from('ffffffffffffffffffffffffffffffff').toString('base64')
  await assert.rejects(() => decryptSecret(blob, otherKey))
})
