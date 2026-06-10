import { getActiveConfig, buildUpstreamUrl } from './activeConfig'
import { authenticateUser } from './auth'
import { HttpError, jsonError, methodNotAllowed } from './errors'
import { buildResponseHeaders, buildUpstreamHeaders, corsPreflight, withCors } from './headers'
import { createRequestId, logRequest } from './logging'
import type { Env, Fetcher } from './types'

export interface HandlerOptions {
  fetcher?: Fetcher
}

function notFound(): Response {
  return jsonError(404, 'tm_not_found', 'Not found.')
}

async function bodyWithActiveModel(request: Request, model: string): Promise<string> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    throw new HttpError(400, 'tm_bad_request', 'Request body must be valid JSON.')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'tm_bad_request', 'Request body must be a JSON object.')
  }

  return JSON.stringify({
    ...(parsed as Record<string, unknown>),
    model,
  })
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
  const upstreamUrl = buildUpstreamUrl(config)
  const requestBody = await bodyWithActiveModel(request, config.model)
  const { headers: upstreamHeaders, providerKey } = buildUpstreamHeaders(request, config, env)
  const fetcher = options.fetcher ?? globalThis

  let upstream: Response
  try {
    upstream = await fetcher.fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: requestBody,
      signal: request.signal,
    })
  } catch {
    return jsonError(502, 'tm_upstream_transport_error', 'Unable to reach active AI provider.')
  }

  const durationMs = Date.now() - startedAt
  
  let responseBody: ReadableStream | string | null = upstream.body
  if (upstream.status === 400) {
    const errorText = await upstream.text()
    console.error(`[ai-pass-through] Upstream 400 Error Body:`, errorText)
    responseBody = errorText
  }

  await logRequest({
    requestId,
    userId: user.userId,
    provider: config.provider,
    model: config.model,
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
      model: config.model,
      configSource: active.source,
      configKey: active.key,
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
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env)
  },
}
