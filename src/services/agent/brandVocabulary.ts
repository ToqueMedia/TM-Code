/**
 * Closed taxonomy of platform-branded terms vs the underlying provider
 * names they replace. This is the single source of truth for both:
 *   1. The agent's system prompt (renders into the Publishing section's
 *      <vocabulary> block — agents must use the user-facing terms in chat).
 *   2. Any future output validator / linter that flags provider names
 *      leaking into agent responses.
 *
 * Adding a new pair here propagates to the system prompt without further
 * edits. The order is the order shown in the prompt (more-leaky terms
 * first so they're top-of-mind).
 *
 * Origin: incident 2026-05-13 — early Cloud Run / Firestore mentions
 * leaked into agent chat output during the login-test deploy session.
 * Rather than rely on prose rules in the system prompt, the vocabulary
 * became code-typed.
 */

export interface BrandTerm {
  /** What the agent says to the developer. */
  userFacing: string
  /** Provider names the agent must NOT volunteer in chat. */
  internal: readonly string[]
}

/** Term count — exposed for prompt-section telemetry. */
export const BRAND_VOCABULARY_LENGTH = 6 as const

export const BRAND_VOCABULARY: readonly BrandTerm[] = [
  {
    userFacing: "TM Code Database / your project's database",
    internal: ['Firestore', 'Cloud Firestore', 'Firebase Database'],
  },
  {
    userFacing: "TM Code Authentication / your project's login",
    internal: ['Firebase Auth', 'Identity Toolkit', 'GIP', 'Google Identity Platform'],
  },
  {
    userFacing: 'TM Code runtime / the platform runtime',
    internal: ['Cloud Run', 'GCP', 'Google Cloud', 'App Engine'],
  },
  {
    userFacing: 'TM Code build pipeline / the platform build',
    internal: ['Cloud Build', 'Docker build pipeline'],
  },
  {
    userFacing: 'TM Code Edge / the platform edge',
    internal: ['Cloudflare', 'Workers', 'R2', 'KV', 'Cloudflare Workers'],
  },
  {
    userFacing: 'platform-managed credentials',
    internal: ['service account key', 'ADC', 'Application Default Credentials', 'GOOGLE_APPLICATION_CREDENTIALS'],
  },
]

/**
 * Render the vocabulary as the XML block consumed by the system prompt.
 * The XML schema matches what the agent expects under
 * `## Publishing` → C. Hide internal infra in chat.
 */
export function renderBrandVocabularyXml(): string {
  const lines: string[] = ['<vocabulary>']
  for (const term of BRAND_VOCABULARY) {
    lines.push('<term>')
    lines.push(`  <user_facing>${term.userFacing}</user_facing>`)
    lines.push(`  <internal_do_not_say>${term.internal.join(', ')}</internal_do_not_say>`)
    lines.push('</term>')
  }
  lines.push('</vocabulary>')
  return lines.join('\n')
}

/**
 * Future output-validator helper: returns the set of internal terms that
 * appeared in a piece of agent-generated chat text. Empty array = clean.
 * Case-insensitive whole-word match (so "GCP" in "GCP_PROJECT_ID" env-var
 * documentation doesn't trip — it's prose-only enforcement).
 */
export function findBrandLeaks(text: string): string[] {
  const leaks: string[] = []
  for (const term of BRAND_VOCABULARY) {
    for (const banned of term.internal) {
      const escaped = banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`\\b${escaped}\\b`, 'i')
      if (re.test(text)) leaks.push(banned)
    }
  }
  return leaks
}
