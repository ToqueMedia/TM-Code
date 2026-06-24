// geminiThinking.ts — make Gemini's (always-on) reasoning VISIBLE in the stream.
//
// Why this exists
// ---------------
// Gemini 2.5 Pro / Gemini 3.x always think, but — unlike GLM/Qwen/MiMo, which
// emit `reasoning_content` unprompted — Gemini only STREAMS its thought
// summaries when the request explicitly asks for them. Without that, the model
// reasons internally and the IDE never receives the
// `delta.content + extra_content.google.thought === true` chunks it renders
// (query.ts), so Gemini reasoning was invisible while every other model showed
// it. (Confirmed against the Gemini OpenAI-compat docs:
// https://ai.google.dev/gemini-api/docs/openai — thought summaries require
// `include_thoughts`.)
//
// Wire shape: the OpenAI SDK's `extra_body={"google": {...}}` flattens to a
// top-level `google` field on the JSON body, which is exactly what the active
// config's `extraBody` already publishes and what the worker merges to the
// body root — so we set `google.thinking_config.include_thoughts` at the root.
//
// Constraints respected (per the docs):
//   - `reasoning_effort` and `thinking_level`/`thinking_budget` cannot coexist
//     → if the body already carries `reasoning_effort`, do nothing.
//   - never clobber an explicit `include_thoughts` (true OR false) the
//     client/active-config chose, nor a level/budget already set.

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Ensure a Gemini request asks for thought summaries. Mutates `body` in place.
 * Idempotent and conservative — see the constraints above.
 */
export function ensureGeminiThoughtSummaries(body: Record<string, unknown>): void {
  // reasoning_effort drives thinking via the OpenAI-style knob; the two shapes
  // are mutually exclusive, so we must not also inject google.thinking_config.
  if ('reasoning_effort' in body) return

  const google = asRecord(body.google) ?? {}
  const thinkingConfig = asRecord(google.thinking_config) ?? {}

  // Only fill in a MISSING include_thoughts — respect an explicit choice.
  if (thinkingConfig.include_thoughts === undefined) {
    thinkingConfig.include_thoughts = true
  }

  google.thinking_config = thinkingConfig
  body.google = google
}

/**
 * Vertex AI's OpenAI-compat endpoint requires a `<publisher>/<model>` model id.
 * A bare id (e.g. `gemini-3.1-pro-preview`) returns 400 "Malformed publisher
 * model … expected '<publisher>/<model>'". Default the publisher to `google/`
 * when the id carries none; ids that already have one (`google/…`, `meta/…`,
 * Model Garden, etc.) are returned unchanged. Pure — caller decides when Vertex
 * (google_oauth) is in play.
 */
export function ensureVertexPublisher(model: string): string {
  return typeof model === 'string' && model !== '' && !model.includes('/')
    ? `google/${model}`
    : model
}
