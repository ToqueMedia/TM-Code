import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureGeminiThoughtSummaries, ensureVertexPublisher } from '../src/geminiThinking'

/**
 * Garante que pedidos Gemini (google_oauth) pedem os resumos de pensamento.
 * Sem include_thoughts, a Vertex pensa mas não transmite — e o reasoning do
 * Gemini nunca chegava à IDE (ao contrário dos modelos que emitem
 * reasoning_content por omissão).
 */

test('injects include_thoughts when nothing thinking-related is present', () => {
  const body: Record<string, unknown> = { model: 'google/gemini-3.1-pro-preview', messages: [] }
  ensureGeminiThoughtSummaries(body)
  assert.deepEqual(body.google, { thinking_config: { include_thoughts: true } })
})

test('preserves an existing thinking_level and only adds include_thoughts', () => {
  const body: Record<string, unknown> = {
    google: { thinking_config: { thinking_level: 'high' } },
  }
  ensureGeminiThoughtSummaries(body)
  assert.deepEqual(body.google, { thinking_config: { thinking_level: 'high', include_thoughts: true } })
})

test('respects an explicit include_thoughts:false (never clobbers intent)', () => {
  const body: Record<string, unknown> = {
    google: { thinking_config: { include_thoughts: false } },
  }
  ensureGeminiThoughtSummaries(body)
  assert.deepEqual(body.google, { thinking_config: { include_thoughts: false } })
})

test('does nothing when reasoning_effort is set (mutually exclusive with thinking_config)', () => {
  const body: Record<string, unknown> = { reasoning_effort: 'low' }
  ensureGeminiThoughtSummaries(body)
  assert.equal('google' in body, false)
})

test('preserves sibling google fields', () => {
  const body: Record<string, unknown> = { google: { safety_settings: [] } }
  ensureGeminiThoughtSummaries(body)
  assert.deepEqual(body.google, { safety_settings: [], thinking_config: { include_thoughts: true } })
})

test('tolerates a non-object google field', () => {
  const body: Record<string, unknown> = { google: 'nonsense' }
  ensureGeminiThoughtSummaries(body)
  assert.deepEqual(body.google, { thinking_config: { include_thoughts: true } })
})

// ── ensureVertexPublisher ────────────────────────────────────────────────────

test('adds the google/ publisher prefix to a bare Vertex model id', () => {
  assert.equal(ensureVertexPublisher('gemini-3.1-pro-preview'), 'google/gemini-3.1-pro-preview')
  assert.equal(ensureVertexPublisher('gemini-3.5-flash'), 'google/gemini-3.5-flash')
})

test('leaves an already-qualified publisher untouched', () => {
  assert.equal(ensureVertexPublisher('google/gemini-3.1-pro-preview'), 'google/gemini-3.1-pro-preview')
  assert.equal(ensureVertexPublisher('meta/llama-3.1-405b'), 'meta/llama-3.1-405b')
})

test('passes an empty model through unchanged', () => {
  assert.equal(ensureVertexPublisher(''), '')
})
