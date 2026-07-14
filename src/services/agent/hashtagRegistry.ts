import { extractHashtags } from '../../utils/hashtagParser'
import { t } from '@/i18n'

/**
 * Closed vocabulary of skill-trigger hashtags. The prompt-bar autocomplete
 * surfaces these when the user types `#`, and the submit-time detector reads
 * them back out of the text.
 *
 * Anything not in this list is ignored — free-form `#tags` (issue refs, etc.)
 * pass through to the agent as plain text. Add a new entry only when there's
 * a corresponding skill bundle to load.
 *
 * NOTE (2026-07): the managed-auth tags (`#auth-email-password`,
 * `#auth-google`) were removed with the MANAGED-PLATFORM layer — the IDE
 * agent is a pure dev tool; managed provisioning lives in TM Code Web.
 */
export interface HashtagOption {
  /** The full tag including the leading '#'. */
  tag: string
  /** One-line label shown in the autocomplete menu. */
  description: string
}

export const HASHTAG_OPTIONS: HashtagOption[] = [
  { tag: '#design', description: t('hashtag.designShort') },
]

/**
 * Filter the registry by the in-progress query (the chars typed AFTER `#`).
 * Match is case-insensitive and prefix-only on the tag body.
 */
export function filterHashtagOptions(query: string): HashtagOption[] {
  if (!query) return HASHTAG_OPTIONS
  const q = query.toLowerCase()
  return HASHTAG_OPTIONS.filter(opt =>
    opt.tag.slice(1).toLowerCase().startsWith(q),
  )
}

const DESIGN_TAG_TOKEN = 'design'

export interface PreprocessedHashtags {
  /** True when `#design` is present — caller should force-load `frontend-design`. */
  hasDesign: boolean
  /** Original text minus all recognised hashtags (whitespace collapsed). */
  cleanedText: string
}

/**
 * Single-pass detector for ALL recognised hashtags. Strips them from the
 * text and returns what was found. Walking backwards keeps later indices
 * valid as we remove earlier tags. Unknown hashtags pass through.
 *
 * Hashtags must be whitespace-delimited (same rule as the parser): a `#`
 * mid-word doesn't trigger.
 */
export function preprocessHashtags(text: string): PreprocessedHashtags {
  const tags = extractHashtags(text)
  if (tags.length === 0) {
    return { hasDesign: false, cleanedText: text }
  }

  let hasDesign = false
  let cleaned = text

  for (let i = tags.length - 1; i >= 0; i--) {
    const tag = tags[i]
    const lowerToken = tag.token.toLowerCase()
    if (lowerToken === DESIGN_TAG_TOKEN) {
      hasDesign = true
      cleaned = cleaned.slice(0, tag.start) + cleaned.slice(tag.end)
    }
    // Unknown tags pass through untouched.
  }

  cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  return { hasDesign, cleanedText: cleaned }
}
