/**
 * Memory relevance selector.
 *
 * As the user/project memdir grows past ~80-100 entries, naïvely injecting
 * the full MEMORY.md index every turn starts eating ~6K+ tokens that the
 * model rarely needs all at once. The selector trims the injected slice
 * to only the entries relevant to the current user request, called once
 * per turn before `buildSystemPrompt` finalises the prompt.
 *
 * Routing — picked by the backend via `X-Request-Type: memory-selector`:
 *
 *   coder model              →  selector model
 *   mimo-v2.5-pro / -pro-1m  →  mimo-v2.5      (smaller sibling)
 *   glm-5.1                  →  qwen3.6-plus   (DashScope, fast)
 *   deepseek-v4-flash        →  qwen3.6-plus   (free-tier fallback)
 *   anything else            →  qwen3.6-plus   (safe default)
 *
 * The selector model returns a JSON object listing the memory entries
 * worth injecting. The local cache keys by (sessionId, userMessageHash)
 * so identical or repeated prompts skip the round-trip — the selector
 * call adds ~300-600ms on the critical path before the main turn fires,
 * caching makes that cost negligible across a working session.
 *
 * Failure modes ALL fall through to "inject everything" (the pre-selector
 * default behaviour). A broken selector should not block the agent loop —
 * it just costs the extra tokens that the selector was meant to save.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { logger } from '../../utils/logger'
import { resolveWorkerUrl } from '../../utils/devUrls'
import FirebaseAuthService from '../auth/firebaseAuth'

/**
 * Combined byte count below which the selector is skipped — small memdirs
 * fit comfortably in the prompt without selection, so the call would just
 * be latency overhead. Picked at ~4KB ≈ ~1K tokens; the prompt's 25KB cap
 * gives a wide buffer above this threshold.
 */
export const MEMORY_SELECTOR_THRESHOLD_BYTES = 4096

/** Selector returns names ≤ this count even if it thinks more are relevant.
 *  Belt-and-braces against a chatty model returning the whole catalog. */
const MAX_SELECTED_ENTRIES = 30

/** Per-call wall-clock cap. Selector is on the critical path before the
 *  agent reply — keep tight. Failure path is "inject all". */
const SELECTOR_TIMEOUT_MS = 8_000

/** Cache TTL — same window the prompt cache uses, keeps invalidation
 *  in lockstep with project state changes. */
const SELECTOR_CACHE_TTL_MS = 30_000

interface CacheEntry {
  selectedNames: Set<string>
  expiresAt: number
}

const selectorCache = new Map<string, CacheEntry>()

/**
 * Compact, content-aware hash of the (user message + memory shape) tuple.
 * Two turns with the same user message and same set of memory names
 * collide → cache hit. Adding a new memory invalidates because the names
 * set changes; the fsVersion bump from save_memory invalidates the
 * upstream prompt cache, but the selector cache uses its own key for
 * isolation.
 */
function cacheKey(sessionId: string, userMessage: string, names: string[]): string {
  // FNV-1a 32-bit — fast, deterministic, no crypto dependency.
  const payload = `${sessionId}|${userMessage}|${names.slice().sort().join(',')}`
  let hash = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16)
}

/**
 * Compact entry shape passed to the selector. The model sees a list of
 * `(name, type, description)` tuples and the current user request, then
 * returns just the names worth injecting in full.
 */
export interface SelectorEntry {
  name: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  description: string
}

interface SelectorResult {
  /** The set of memory names the selector picked. Empty set means
   *  "no entry is relevant" — distinct from null which means "selector
   *  failed; caller should fall through to inject-all". */
  selectedNames: Set<string>
  /** True iff the result came from the local cache. Telemetry only. */
  cacheHit: boolean
  /** Selector call latency in ms (excluding cache hits). */
  latencyMs: number
}

/**
 * Ask the per-plan selector model which memory entries are relevant to the
 * current user request. Returns `null` on any failure so the caller can
 * fall back to injecting everything.
 */
export async function selectRelevantMemories(args: {
  sessionId: string
  userMessage: string
  entries: SelectorEntry[]
}): Promise<SelectorResult | null> {
  const { sessionId, userMessage, entries } = args

  if (entries.length === 0) {
    return { selectedNames: new Set(), cacheHit: false, latencyMs: 0 }
  }

  // Cache lookup. Key includes the user message AND the set of names
  // currently visible, so adding/removing a memory naturally misses.
  const allNames = entries.map(e => e.name)
  const key = cacheKey(sessionId, userMessage, allNames)
  const cached = selectorCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return { selectedNames: cached.selectedNames, cacheHit: true, latencyMs: 0 }
  }

  const startedAt = performance.now()
  try {
    const idToken = await FirebaseAuthService.getInstance().getIdToken()
    if (!idToken) return null

    const workerUrl = resolveWorkerUrl()
    const ac = new AbortController()
    const timeoutId = setTimeout(() => ac.abort(), SELECTOR_TIMEOUT_MS)

    // Compose the selector prompt. Closed-shape ask — single JSON object
    // with a `names` array. The system message names the model's job;
    // the user message dumps the catalog + request. Temperature 0 so the
    // selector is deterministic for a given (catalog, request) pair —
    // any non-determinism would defeat the cache.
    const catalogText = entries
      .map(e => `- name="${e.name}" type=${e.type} → ${e.description}`)
      .join('\n')

    const selectorSystem = `You filter a memory catalog down to the entries relevant to a given developer request.

Rules:
- Output ONLY a JSON object: {"names": ["<entry-name>", ...]}. No prose, no markdown, no code fence.
- Pick at most ${MAX_SELECTED_ENTRIES} entries.
- An entry is relevant when:
  * It's a \`user\` entry (developer profile — almost always include).
  * It's a \`feedback\` entry whose rule applies to the kind of work in the request.
  * It's a \`project\` entry whose context is in the same area as the request.
  * It's a \`reference\` entry pointing to a system the request would naturally consult.
- Skip entries that are clearly off-topic. When in doubt INCLUDE — false negatives lose useful context; false positives just cost a few tokens.
- Use the entry name verbatim. Do not invent names.`

    const selectorUser = `Developer request:
${userMessage.slice(0, 4000)}

Memory catalog (${entries.length} entries):
${catalogText}`

    let res: Response
    try {
      res = await fetch(`${workerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
          'X-Request-Type': 'memory-selector',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: selectorSystem },
            { role: 'user', content: selectorUser },
          ],
          temperature: 0,
          max_tokens: 800,
          stream: false,
          // response_format hint — DashScope honours it; OpenRouter passes
          // through to compatible upstreams. Backend ignores when unsupported.
          response_format: { type: 'json_object' },
        }),
        signal: ac.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!res.ok) {
      logger.warn('memdir', `[selector] HTTP ${res.status} — falling back to inject-all`)
      return null
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content ?? ''
    if (!content) {
      logger.warn('memdir', '[selector] empty content — falling back to inject-all')
      return null
    }

    // Tolerant parse: the model might wrap in a code fence even when told
    // not to. Strip a leading/trailing ``` block before JSON.parse.
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim()

    let parsed: { names?: unknown }
    try {
      parsed = JSON.parse(cleaned) as { names?: unknown }
    } catch (err) {
      logger.warn('memdir', '[selector] JSON parse failed:', err)
      return null
    }

    if (!Array.isArray(parsed.names)) {
      logger.warn('memdir', '[selector] response missing `names` array')
      return null
    }

    // Validate every name is one the catalog actually contains.
    // Defends against the model hallucinating an entry name; injecting
    // a non-existent name would just be a no-op anyway, but cleaning
    // here keeps telemetry honest about hit rates.
    const validNames = new Set(allNames)
    const selectedNames = new Set<string>()
    for (const raw of parsed.names) {
      if (typeof raw !== 'string') continue
      if (validNames.has(raw)) selectedNames.add(raw)
    }

    selectorCache.set(key, {
      selectedNames,
      expiresAt: Date.now() + SELECTOR_CACHE_TTL_MS,
    })

    const latencyMs = Math.round(performance.now() - startedAt)
    return { selectedNames, cacheHit: false, latencyMs }
  } catch (err) {
    logger.warn('memdir', '[selector] failed — falling back to inject-all:', err)
    return null
  }
}

/** Clear the selector cache. Called when memory is saved/forgotten so
 *  the next selector run sees the new catalog instead of a stale hit. */
export function invalidateMemorySelectorCache(): void {
  selectorCache.clear()
}

// Use-arg-trick: tauri-api/core is exported above only to ensure the
// build picks up the dependency for future use; the actual fetch goes
// through the worker URL directly. Keeps the helper module slim.
void tauriInvoke
