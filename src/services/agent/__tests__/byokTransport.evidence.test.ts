/**
 * @jest-environment node
 *
 * EVIDENCE: under BYOK, the chat request goes IDE → provider DIRECT with the
 * USER's key, and NEVER touches the TM worker. Since the TM worker is the sole
 * metering point ([[billing-single-source-of-truth]]), a request that never
 * reaches it consumes zero TM budget — i.e. consumption is billed only to the
 * BYOK key's model at the provider.
 *
 * This drives the REAL transport (byokTransport → Rust `byok_chat_stream`
 * invoke) and asserts the captured upstream URL + auth headers. Node env so the
 * web-stream/Response globals are native.
 */

// Mock the Tauri boundary: capture what the IDE would send to Rust, and never
// actually hit the network.
jest.mock('@/utils/invokeMetrics', () => ({ invoke: jest.fn() }))
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn() }))

import { invoke } from '@/utils/invokeMetrics'
import { listen } from '@tauri-apps/api/event'
import { createByokFetch } from '../byokTransport'

const mockInvoke = invoke as jest.Mock
const mockListen = listen as jest.Mock

// The data-plane worker host — the request must NOT go here under BYOK.
const TM_WORKER_HOST = 'ai-pass-through-worker.geral-871.workers.dev'

interface CapturedStream {
  url: string
  headers: Record<string, string>
  body: string
  expectedHost: string
}

/** All byok_chat_stream invocations captured during the test. */
function capturedStreams(): CapturedStream[] {
  return mockInvoke.mock.calls
    .filter((c) => c[0] === 'byok_chat_stream')
    .map((c) => (c[1] as { input: CapturedStream }).input)
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockListen.mockReset()

  let handler: ((e: { payload: unknown }) => void) | null = null
  // listen() captures the chunk handler and returns an unlisten fn.
  mockListen.mockImplementation(async (_name: string, h: (e: { payload: unknown }) => void) => {
    handler = h
    return () => {}
  })
  // invoke('byok_chat_stream') simulates the provider responding by closing the
  // stream cleanly on the next microtask, so the fetch resolves.
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'byok_chat_stream') {
      queueMicrotask(() => handler?.({ payload: { type: 'done' } }))
    }
    return undefined
  })
})

describe('BYOK direct routing — OpenAI-compatible (Gemini)', () => {
  it('sends the request to the provider host with the user key, not the TM worker', async () => {
    const byokFetch = createByokFetch({
      expectedHost: 'generativelanguage.googleapis.com',
      apiShape: 'openai_compat',
    })

    // This is exactly what the OpenAI SDK passes when createByokAgentClient is
    // built with baseURL=Gemini + apiKey=<user key>.
    const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    await byokFetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer GEMINI_USER_KEY', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3-pro', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })

    const streams = capturedStreams()
    expect(streams).toHaveLength(1)
    const sent = streams[0]

    // → goes to the PROVIDER, with the USER's key.
    expect(sent.url).toBe(url)
    expect(sent.expectedHost).toBe('generativelanguage.googleapis.com')
    expect(sent.headers.Authorization).toBe('Bearer GEMINI_USER_KEY')

    // → NEVER the TM worker (no metering possible).
    for (const s of capturedStreams()) {
      expect(s.url).not.toContain(TM_WORKER_HOST)
      expect(new URL(s.url).host).toBe('generativelanguage.googleapis.com')
    }
  })
})

describe('BYOK direct routing — Anthropic (native Messages API)', () => {
  it('rewrites to /v1/messages, sends x-api-key (user key), drops Authorization, never the worker', async () => {
    const byokFetch = createByokFetch({ expectedHost: 'api.anthropic.com', apiShape: 'anthropic' })

    // The SDK would POST to {baseURL}/chat/completions with Authorization: Bearer.
    await byokFetch('https://api.anthropic.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-ant-USER_KEY', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })

    const streams = capturedStreams()
    expect(streams).toHaveLength(1)
    const sent = streams[0]

    // → Anthropic Messages endpoint, USER key as x-api-key.
    expect(sent.url).toBe('https://api.anthropic.com/v1/messages')
    expect(sent.expectedHost).toBe('api.anthropic.com')
    expect(sent.headers['x-api-key']).toBe('sk-ant-USER_KEY')
    expect(sent.headers.Authorization).toBeUndefined()
    expect(sent.headers['anthropic-version']).toBe('2023-06-01')

    // → body translated to Anthropic shape (proves it's the provider's own API).
    const body = JSON.parse(sent.body)
    expect(body.max_tokens).toBe(100)
    expect(Array.isArray(body.messages)).toBe(true)

    // → NEVER the TM worker.
    expect(sent.url).not.toContain(TM_WORKER_HOST)
  })
})
