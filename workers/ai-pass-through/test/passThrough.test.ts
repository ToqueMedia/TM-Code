import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test, { beforeEach } from 'node:test'
import { clearActiveConfigCache } from '../src/activeConfig'
import { handleRequest } from '../src/index'
import { clearPlanCache } from '../src/planGate'
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
} = {}): Response {
  return Response.json({
    fields: {
      userPlan: { stringValue: opts.plan ?? 'explorer' },
      tokenBudget: {
        mapValue: {
          fields: {
            tokensConsumed: { integerValue: String(opts.tokensConsumed ?? 0) },
            extraUsageBalance: { integerValue: String(opts.extraUsageBalance ?? 0) },
            cycleEnd: { stringValue: opts.cycleEnd ?? '2026-12-31' },
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
function fakeFetcher(response: Response, firestoreDoc?: () => Response) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit; body: any; headers: Headers }> = []
  const firestoreCalls: Array<{ input: RequestInfo | URL; method: string; body: any; headers: Headers }> = []
  return {
    calls,
    firestoreCalls,
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input)
      const headers = new Headers(init?.headers)
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

test('non-streaming bodies do not get stream_options injected', async () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], stream: false }
  const fetcher = fakeFetcher(Response.json({ ok: true }))
  await handleRequest(request('/v1/chat/completions', body), env(), { fetcher })

  assert.equal(fetcher.calls[0].body.stream_options, undefined)
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
  // usage.ts é a ÚNICA exceção sancionada: observa o stream para extrair o
  // objeto `usage` (billing autoritativo) através de um identity-transform —
  // bytes out ≡ bytes in, nada é injetado (o teste de streaming acima
  // continua a garantir isso byte a byte). A proibição mantém-se para todo o
  // resto do worker: a lição do proxy antigo foi sobre MUTAÇÃO do stream.
  const files = await workerSourceFiles()
  const source = files
    .filter(file => file.file !== 'auth.ts' && file.file !== 'usage.ts')
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

test('billing: enforce mode lets an overage user through (extraUsageBalance > 0)', async () => {
  const fetcher = fakeFetcher(
    Response.json({ ok: true }),
    () => firestoreUserDoc({ plan: 'explorer', tokensConsumed: 2_000_000, extraUsageBalance: 500_000 }),
  )
  const res = await handleRequest(request(), env({ BUDGET_ENFORCEMENT: 'enforce' }), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-budget-status'), 'allowed_overage')
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
  assert.equal(transforms[1].fieldPath, 'tokenBudget.extraUsageBalance')
  assert.equal(transforms[1].increment.integerValue, '-150')
  // overageConsumed rastreia o overage pago — input do carry-over no reset
  // de ciclo (não cobrar duas vezes o excedente já pago via saldo extra).
  assert.equal(transforms[2].fieldPath, 'tokenBudget.overageConsumed')
  assert.equal(transforms[2].increment.integerValue, '150')
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

test('billing: BUDGET_ENFORCEMENT=off skips the Firestore read, headers and commit', async () => {
  const fetcher = fakeFetcher(sseUpstream([USAGE_CHUNK]))
  const { tasks, ctx } = collectorCtx()

  const res = await handleRequest(
    request('/v1/chat/completions', { stream: true }),
    env({ BUDGET_ENFORCEMENT: 'off' }),
    { fetcher, ctx },
  )
  await res.text()
  await Promise.all(tasks)

  assert.equal(res.headers.get('x-budget-status'), null)
  assert.equal(fetcher.firestoreCalls.length, 0)
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
