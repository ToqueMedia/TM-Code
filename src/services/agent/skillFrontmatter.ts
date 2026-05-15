/**
 * Pure skill frontmatter parser — **no Tauri / React / Zustand dependencies**.
 *
 * Lives in its own file (instead of inside skillService.ts) so that tooling
 * scripts outside the Tauri runtime — notably `scripts/verify-skills.ts` — can
 * import the exact same logic used in production. Any future SKILL.md schema
 * change touches this one file and the CI verifier stays in sync automatically.
 */

/** Upper bound for description length shown in the in-prompt skill index. */
export const MAX_DESCRIPTION_CHARS = 220

export interface ParsedSkill {
  name: string
  description: string
  /** Markdown body with the YAML frontmatter stripped, if any. */
  body: string
  /** Whether this SKILL's body is safe to cache across turns. Defaults to
   *  true — every SKILL today is filesystem-static. Set to false ONLY when
   *  the body interpolates per-session state (project path, env, etc.).
   *  When false, `noCacheReason` MUST explain what makes it volatile —
   *  cache-busting is an architectural decision, not a default. Mirrors
   *  the `DANGEROUS_uncachedSystemPromptSection` pattern. */
  cacheable: boolean
  /** Required when `cacheable === false`. Free-text justification surfaced
   *  by the verifier so reviewers can challenge the call. */
  noCacheReason?: string
}

/** Surfaced by the verifier (and SkillService at load time) when a SKILL
 *  declares `cacheable: false` without a `noCacheReason`. Treated as a
 *  validation error — the field exists to force a deliberate trade-off,
 *  not as a silent invalidation toggle. */
export class SkillFrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillFrontmatterError'
  }
}

/**
 * Parse YAML frontmatter from a SKILL.md.
 * Recognized fields: name (string), description (string).
 * Falls back to the first heading + first non-empty paragraph when no frontmatter
 * is present (preserves backward compat with pre-existing skills).
 */
export function parseSkillFrontmatter(raw: string, fallbackName: string): ParsedSkill {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (fmMatch) {
    const [, fmBlock, body] = fmMatch
    const nameLine = fmBlock.match(/^name:\s*(.+)$/m)
    const descLine = fmBlock.match(/^description:\s*([\s\S]+?)(?=\n\w+:|\n*$)/m)
    const cacheableLine = fmBlock.match(/^cacheable:\s*(true|false)\s*$/m)
    const noCacheReasonLine = fmBlock.match(/^noCacheReason:\s*(.+)$/m)
    const name = nameLine ? nameLine[1].trim() : fallbackName
    let description = descLine ? descLine[1].trim().replace(/\s+/g, ' ') : deriveDescription(body, fallbackName)
    if (description.length > MAX_DESCRIPTION_CHARS) {
      description = description.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd() + '…'
    }
    // Default cacheable=true. The field is opt-IN to invalidation so a
    // missing field can never accidentally bypass the prompt cache.
    const cacheable = cacheableLine ? cacheableLine[1] === 'true' : true
    const noCacheReason = noCacheReasonLine ? noCacheReasonLine[1].trim() : undefined
    if (!cacheable && !noCacheReason) {
      throw new SkillFrontmatterError(
        `${name}: cacheable=false requires noCacheReason — explain what makes the body session-volatile (project path, env, etc.). ` +
        `Cache-busting is an architectural decision, not a default. If the SKILL is in fact static, drop the cacheable field.`,
      )
    }
    return { name, description, body: body.trimStart(), cacheable, noCacheReason }
  }
  // No frontmatter — derive from content
  let description = deriveDescription(raw, fallbackName)
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = description.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd() + '…'
  }
  return { name: fallbackName, description, body: raw, cacheable: true }
}

/** First non-empty paragraph after the H1 — single line, collapsed whitespace. */
function deriveDescription(content: string, fallbackName: string): string {
  const lines = content.split(/\r?\n/)
  let pastH1 = false
  const buf: string[] = []
  for (const line of lines) {
    if (!pastH1 && line.trim().startsWith('# ')) {
      pastH1 = true
      continue
    }
    if (!pastH1) continue
    const trimmed = line.trim()
    if (!trimmed) {
      if (buf.length) break
      continue
    }
    if (trimmed.startsWith('#')) break // hit next heading without content
    buf.push(trimmed)
    if (buf.join(' ').length > MAX_DESCRIPTION_CHARS) break
  }
  const desc = buf.join(' ').trim()
  return desc || fallbackName
}
