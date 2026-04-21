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
    const name = nameLine ? nameLine[1].trim() : fallbackName
    let description = descLine ? descLine[1].trim().replace(/\s+/g, ' ') : deriveDescription(body, fallbackName)
    if (description.length > MAX_DESCRIPTION_CHARS) {
      description = description.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd() + '…'
    }
    return { name, description, body: body.trimStart() }
  }
  // No frontmatter — derive from content
  let description = deriveDescription(raw, fallbackName)
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = description.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd() + '…'
  }
  return { name: fallbackName, description, body: raw }
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
