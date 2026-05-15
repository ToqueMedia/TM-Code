// ── Base URL normalisation ──
//
// Single source of truth for trimming user-supplied provider base URLs.
// Applied uniformly for every provider (anthropic, openai, openrouter,
// gemini, deepseek, xai, ollama, custom, …) by routing every Settings
// input through `byokStore.setBaseURL`, which calls this helper.
//
// Convention: the value stored is the API ROOT — the backend proxy
// appends provider-specific paths (`/chat/completions`, `/v1/messages`,
// `/api/chat`, …). Without trimming, users routinely copy the full
// endpoint URL from provider docs and produce doubled paths like
// `…/v1/chat/completions/chat/completions`.
//
// Lives in its own module (no Firebase / Tauri imports) so the
// pure-function test suite can import it under Jest without ESM
// transform errors from byokStore's wider dependency graph.

// Patterns trimmed (case-insensitive, anchored at end):
//   - trailing `/` (any number)
//   - `/chat/completions`        — OpenAI-compatible providers (KEEPS /v1)
//   - `/responses`               — OpenAI Responses API
//   - `/v1/messages`             — Anthropic Messages API (drops /v1; Anthropic
//                                  default baseURL is api.anthropic.com without /v1)
//   - `/api/chat`, `/api/generate` — Ollama native endpoints
//   - `/embeddings`              — sometimes pasted from docs
//
// Why no `/v1/chat/completions` super-pattern: pasting that URL on an
// OpenAI-compat provider (StepFun, DeepSeek, …) must leave the trailing
// `/v1` in place — the backend appends `/chat/completions` to whatever
// baseURL it gets, so dropping `/v1` produces 404s upstream. Matching just
// `/chat/completions$` leaves `/v1` intact, which is what every storage
// caller expects (this matches the worker's own strip rule in index.ts).
const BASE_URL_TRIM_PATTERNS: RegExp[] = [
  /\/chat\/completions$/i,
  /\/v1\/messages$/i,
  /\/responses$/i,
  /\/api\/chat$/i,
  /\/api\/generate$/i,
  /\/embeddings$/i,
]

export function cleanBaseURL(input: string | undefined): string | undefined {
  if (input === undefined || input === null) return undefined
  let cleaned = input.trim().replace(/\/+$/, '')
  // Apply patterns iteratively — a pasted URL could end with both
  // `/v1/chat/completions` and a trailing slash; one pass per call is
  // sufficient because each pattern strips its own suffix.
  for (const pattern of BASE_URL_TRIM_PATTERNS) {
    cleaned = cleaned.replace(pattern, '')
  }
  // Strip trailing slash one more time in case a pattern left one.
  cleaned = cleaned.replace(/\/+$/, '')
  return cleaned.length === 0 ? undefined : cleaned
}
