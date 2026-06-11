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

function fakeFetcher(response: Response) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit; body: any; headers: Headers }> = []
  return {
    calls,
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const headers = new Headers(init?.headers)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
      calls.push({ input, init, body, headers })
      return response
    },
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

test('X-TM-Speed without published speedModel falls back without any plan lookup', async () => {
  const fetcher = speedFetcher({ plan: 'pro' })
  const res = await handleRequest(speedRequest(), env(), { fetcher })

  assert.equal(res.status, 200)
  assert.equal(fetcher.planCalls.length, 0)
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
  assert.equal(fetcher.planCalls.length, 0)
  assert.equal(fetcher.upstreamCalls[0].body.model, activeConfig.model)
  assert.equal(res.headers.get('x-tm-model'), activeConfig.model)
  assert.equal(res.headers.get('x-tm-speed-applied'), 'false')
})

test('body is preserved except for the active model field', async () => {
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

  assert.deepEqual(fetcher.calls[0].body, {
    ...body,
    model: activeConfig.model,
  })
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
  let calls = 0
  const fetcher = {
    async fetch() {
      calls += 1
      throw new Error('network failed')
    },
  }
  const res = await handleRequest(request(), env(), { fetcher })

  assert.equal(res.status, 502)
  assert.equal(calls, 1)
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

test('data-plane handler has no SSE parser or response TransformStream', async () => {
  const files = await workerSourceFiles()
  const source = files
    .filter(file => file.file !== 'auth.ts')
    .map(file => file.source)
    .join('\n')

  assert.doesNotMatch(source, /TransformStream/)
  assert.doesNotMatch(source, /\.body\.getReader\(\)|reader\.read\(/)
  assert.doesNotMatch(source, /TextDecoder/)
  assert.doesNotMatch(source, /\.split\(['"`]\\n['"`]\)|\.split\(['"`]\\r\\n['"`]\)/)
  assert.doesNotMatch(source, /data:/)
})
