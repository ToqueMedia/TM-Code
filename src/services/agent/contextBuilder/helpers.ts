/**
 * Module-level helpers + constants used across the contextBuilder slice.
 *
 * Moved here from the original `contextBuilder.ts` (May 2026 refactor) so the
 * orchestrator class can stay focused on prompt assembly. Behaviour is
 * preserved byte-for-byte — these are pure functions / static constants with
 * no `this` dependencies.
 */

/**
 * Sanitize user-controlled content before embedding in the system prompt.
 * Prevents prompt injection via project files (README.md, TMS.md, etc.)
 * by escaping XML-like tags that could confuse section boundaries.
 */
export function sanitizeProjectContent(content: string): string {
  return content
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
}

/**
 * Maximum size of a single skill's CRITICAL block before we truncate. Picked
 * empirically: the auth-proxy skill's CRITICAL block is ~6kB, so this
 * leaves headroom while staying within a reasonable per-skill prompt budget.
 * Exported for tests.
 */
// Per-skill byte cap for inlined CRITICAL sections. Raised from 8K → 12K
// in 2026-05 after measurements showed `auth-proxy/SKILL.md` was emitting
// ~21K of CRITICAL content and the truncation was dropping the "Port 5173
// must hold" rule + the entire tactical libSQL/signInWithIdp protocol
// (`USE /v1`, `postBody/requestUri`, `providerId vs provider_id`) —
// regressions in those rules cost the most when broken (silent 400s,
// snake-case body bugs). +4K per turn when auth-proxy is sticky-inlined;
// no other bundled skill currently exceeds 8K, so other skills are
// unaffected. If a new skill blows past 12K, prefer trimming inside the
// skill before raising this further.
export const CRITICAL_SECTIONS_MAX_BYTES = 12_000

/**
 * Detect skill-trigger hashtags in a user message. Returns the list of skill
 * names whose CRITICAL sections should be inlined into the prompt this turn.
 * Empty when no recognised tags are present.
 *
 * The point: turn-1 reinforcement before scaffoldingDetector has filesystem
 * markers to find. The user has already declared intent via `#auth-google`,
 * so the rules should already be in context — not waiting for the next turn.
 *
 * Exported for unit tests.
 */
export function skillsFromHashtags(message: string | undefined): string[] {
  if (!message) return []
  // Negative lookbehind: # must be at start-of-string OR preceded by
  // whitespace/punctuation. (\B is wrong here because between two `#`
  // chars it counts as non-word-boundary and would match `a###tag`.)
  const skills = new Set<string>()
  if (/(?<!\S)#auth-(google|email-password)\b/i.test(message)) {
    skills.add('auth-proxy')
  }
  if (/(?<!\S)#auth-google\b/i.test(message)) {
    skills.add('google-signin')
  }
  if (/(?<!\S)#design\b/i.test(message)) {
    skills.add('frontend-design')
  }
  return Array.from(skills)
}

/**
 * Per-extraction metadata. Returned alongside the extracted text so the
 * call site can emit telemetry without re-parsing the body.
 */
export interface CriticalExtractionStats {
  /** Total bytes of the extracted text (after the optional truncation). */
  byteCount: number
  /** Number of `## CRITICAL ...` H2 blocks captured. */
  h2Count: number
  /** Number of `### CRITICAL ...` H3 sub-blocks within those H2 blocks. */
  h3Count: number
  /** True iff the extraction hit the byte cap and trailing content was dropped. */
  wasTruncated: boolean
  /** Bytes captured before truncation (== byteCount when not truncated). */
  rawByteCount: number
}

export interface CriticalExtractionResult {
  text: string
  stats: CriticalExtractionStats
}

/**
 * Pull every "CRITICAL" block from a skill's markdown body. Captures three
 * shapes — H2 ("## CRITICAL: ..."), H3 nested inside an H2 critical block,
 * AND orphan H3 ("### CRITICAL — ...") that lives under a non-critical H2 —
 * plus the explicit "## Hard rules" block when present.
 *
 * The orphan-H3 case is the common one for the auth-proxy skill, which
 * documents its endpoints in an "## the auth API REST endpoints you'll call"
 * H2 with `### CRITICAL — postBody/requestUri` H3s underneath. Without
 * orphan-H3 capture those rules silently vanish from any critical-only
 * slice, which is exactly what the verifier needs to look at.
 *
 * Tolerated variants for the H2/H3 trigger:
 *   ## CRITICAL: ...        ## Critical — ...      ## **CRITICAL** ...
 *   ## ⚠️ CRITICAL ...      ## Hard rules           ## Hard Rules
 *   ### CRITICAL — ...      ### CRITICAL: ...
 *
 * On truncation, prepends a NAMED warning (not a silent suffix) so the
 * model knows content was dropped and the SKILL author sees the cap.
 *
 * Backward-compat: returns just the text. Call sites that need stats
 * should use `extractCriticalSectionsWithStats`.
 */
export function extractCriticalSections(content: string): string {
  return extractCriticalSectionsWithStats(content).text
}

export function extractCriticalSectionsWithStats(content: string): CriticalExtractionResult {
  const lines = content.split('\n')
  const out: string[] = []
  // Two independent in-block states. inH2Critical owns an entire H2 block
  // including its H3 children; inH3CriticalOrphan owns a single H3 block
  // that lives under a non-critical H2. They are never both true at once
  // because an H3 boundary resets inH3CriticalOrphan and an H2 boundary
  // resets BOTH.
  let inH2Critical = false
  let inH3CriticalOrphan = false
  let h2Count = 0
  let h3Count = 0

  const isCriticalH2 = (line: string): boolean => {
    if (!/^##\s/.test(line) || line.startsWith('###')) return false
    const title = line
      .replace(/^##\s+/, '')
      .replace(/^[^A-Za-z]+/, '')
      .replace(/\*+/g, '')
    return /^(CRITICAL|HARD\s*RULES?)\b/i.test(title)
  }

  const isCriticalH3 = (line: string): boolean => {
    if (!/^###\s/.test(line)) return false
    const title = line
      .replace(/^###\s+/, '')
      .replace(/^[^A-Za-z]+/, '')
      .replace(/\*+/g, '')
    return /^(CRITICAL|HARD\s*RULES?)\b/i.test(title)
  }

  for (const line of lines) {
    if (/^##\s/.test(line) && !line.startsWith('###')) {
      // H2 boundary — closes any open orphan H3 block AND decides whether
      // the new H2 itself is a critical container.
      inH3CriticalOrphan = false
      inH2Critical = isCriticalH2(line)
      if (inH2Critical) h2Count++
    } else if (/^###\s/.test(line)) {
      // H3 boundary. If we are inside a critical H2, the H3 just inherits
      // the parent's "we're in a critical block" state — we only need to
      // count it for stats. If we are under a NON-critical H2, decide
      // independently whether to open an orphan critical block.
      const h3IsCritical = isCriticalH3(line)
      if (inH2Critical) {
        if (h3IsCritical) h3Count++
      } else {
        inH3CriticalOrphan = h3IsCritical
        if (h3IsCritical) h3Count++
      }
    }
    if (inH2Critical || inH3CriticalOrphan) {
      out.push(line)
    }
  }

  const joined = out.join('\n').trim()
  const rawByteCount = joined.length

  if (rawByteCount <= CRITICAL_SECTIONS_MAX_BYTES) {
    return {
      text: joined,
      stats: { byteCount: rawByteCount, h2Count, h3Count, wasTruncated: false, rawByteCount },
    }
  }

  // Visible warning replacing the previous silent `[... truncated]` suffix.
  // The header tells the SKILL author *what* hit the cap so the next edit
  // pass can promote less-critical content out of CRITICAL blocks rather
  // than guessing why the model is missing a rule that "is in the prompt".
  const truncated = joined.slice(0, CRITICAL_SECTIONS_MAX_BYTES)
  const warning =
    `\n\n> ⚠️ CRITICAL_SECTIONS_MAX_BYTES (${CRITICAL_SECTIONS_MAX_BYTES.toLocaleString()}) exceeded — ` +
    `${(rawByteCount - CRITICAL_SECTIONS_MAX_BYTES).toLocaleString()} bytes dropped. ` +
    `Promote less-critical content out of \`## CRITICAL ...\` / \`### CRITICAL ...\` blocks ` +
    `(move into a sibling H2 the agent fetches via read_skill on demand).`
  return {
    text: truncated + warning,
    stats: { byteCount: truncated.length + warning.length, h2Count, h3Count, wasTruncated: true, rawByteCount },
  }
}

// Short TTL: long enough to survive rapid successive turns (user follow-ups,
// retries), short enough that edits to TMS.md/PLAN.md/TODO.md surface quickly.
export const PROMPT_CACHE_TTL_MS = 30_000

/**
 * Small deterministic string hash for cache signatures. This is not a
 * security primitive; it only keeps volatile prompt inputs out of cache keys
 * while still invalidating on content changes.
 */
export function stablePromptHash(input: string | null | undefined): string {
  const text = input ?? ''
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/**
 * Static/dynamic boundary marker. Inserted as a literal sentinel between the
 * sections of the system prompt that are stable across sessions (role,
 * tools, doing-tasks rules) and the sections that vary per-session
 * (project memory, scaffolding, environment, MCP). The model harmlessly
 * ignores the literal string; the proxy (`toquemedia-studio-api/src/proxy.ts`)
 * splits the prompt on this marker and emits two `system` blocks with
 * `cache_control: { type: 'ephemeral' }` on the static prefix to maximise
 * prompt-cache reuse across turns.
 *
 * Each bit of dynamic content placed BEFORE the boundary multiplies the
 * cache-key surface by 2 (one variant per turn it changes), so anything
 * that can be static should be — see `dynamicSection()` below for the
 * controlled escape hatch when a section legitimately must invalidate
 * cache mid-prompt.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__TM_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

/**
 * Metadata about a static/dynamic boundary split, returned by
 * `splitOnBoundary()`. Consumed by `prompt_built` telemetry and by the
 * proxy when emitting two `system` blocks.
 */
export interface BoundaryStats {
  /** Bytes of the static (above-boundary) prefix. */
  staticBytes: number
  /** Bytes of the dynamic (below-boundary) suffix. */
  dynamicBytes: number
  /** True when the marker was found and the split was applied. */
  found: boolean
}

/**
 * Split an assembled system prompt on the boundary marker. Returns the
 * prefix (cacheable), suffix (per-session), and byte stats. When the
 * marker is missing (older callers, tests), returns the whole prompt as
 * static with `found: false` so cache hit-rate telemetry can flag the
 * regression.
 */
export function splitOnBoundary(prompt: string): {
  staticPrefix: string
  dynamicSuffix: string
  stats: BoundaryStats
} {
  const idx = prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  if (idx === -1) {
    return {
      staticPrefix: prompt,
      dynamicSuffix: '',
      stats: { staticBytes: prompt.length, dynamicBytes: 0, found: false },
    }
  }
  const staticPrefix = prompt.slice(0, idx).trimEnd()
  const dynamicSuffix = prompt.slice(idx + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).trimStart()
  return {
    staticPrefix,
    dynamicSuffix,
    stats: {
      staticBytes: staticPrefix.length,
      dynamicBytes: dynamicSuffix.length,
      found: true,
    },
  }
}

/**
 * Inverse of static-section composition: a controlled escape hatch for
 * marking a section as legitimately per-turn / per-session, with a written
 * reason explaining why cache invalidation is acceptable. The name is
 * deliberately alarmist — cache-busting is a deliberate architectural
 * decision, not a default. Same idea as Claude Code's
 * `DANGEROUS_uncachedSystemPromptSection` API in claude-vaz
 * (`constants/systemPromptSections.ts`).
 *
 * The body() callback is invoked once per call (no memoisation). The
 * `reason` is required and is currently surfaced only as a code comment —
 * future work can pipe it into `prompt_built` telemetry so we can audit
 * which dynamic sections actually drive cache misses.
 *
 * Usage:
 *
 *     dynamicSection(
 *       'project_memory',
 *       () => getProjectMemorySection(ctx),
 *       'TMS.md / PLAN.md / TODO.md change every commit',
 *     )
 *
 * Returns the section body as `string | null` (compatible with the
 * `.filter()` pipeline in `contextBuilder.ts`). The `reason` is asserted
 * non-empty at call time so authors cannot silently bypass the contract.
 */
export function dynamicSection(
  name: string,
  body: () => string | null,
  reason: string,
): string | null {
  if (!reason || reason.trim().length === 0) {
    throw new Error(
      `dynamicSection("${name}") requires a non-empty reason — ` +
      `cache-busting must be a deliberate decision. Add a one-line ` +
      `justification (e.g. "TMS.md changes every commit") or move ` +
      `the section above SYSTEM_PROMPT_DYNAMIC_BOUNDARY.`,
    )
  }
  return body()
}
