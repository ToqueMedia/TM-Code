import { extractHashtags } from '../../utils/hashtagParser'
import type { Provider } from './commands/authCommand'

/**
 * Closed vocabulary of skill-trigger hashtags. The prompt-bar autocomplete
 * surfaces these when the user types `#`, and the submit-time detector reads
 * them back out of the text.
 *
 * Anything not in this list is ignored — free-form `#tags` (issue refs, etc.)
 * pass through to the agent as plain text. Add a new entry only when there's
 * a corresponding skill bundle to load.
 */
export interface HashtagOption {
  /** The full tag including the leading '#'. */
  tag: string
  /** One-line label shown in the autocomplete menu. */
  description: string
}

export const HASHTAG_OPTIONS: HashtagOption[] = [
  { tag: '#auth-email-password', description: 'Email + password authentication' },
  { tag: '#auth-google',         description: 'Sign in with Google' },
  { tag: '#design',              description: 'Polished UI with bold aesthetic direction — typography, layout, motion' },
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

/** Map of recognised auth-hashtag tokens (without `#`) to their provider. */
const AUTH_TAG_TO_PROVIDER: Record<string, Provider> = {
  'auth-email-password': 'email-password',
  'auth-google': 'google',
}

const DESIGN_TAG_TOKEN = 'design'

export interface AuthHashtagDetection {
  /** Distinct providers signalled by the recognised tags. */
  providers: Provider[]
  /** Original text minus the recognised auth hashtags (whitespace collapsed). */
  cleanedText: string
}

export interface PreprocessedHashtags {
  /** Distinct auth providers signalled by `#auth-*` tags. */
  authProviders: Provider[]
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
    return { authProviders: [], hasDesign: false, cleanedText: text }
  }

  const providers = new Set<Provider>()
  let hasDesign = false
  let cleaned = text

  for (let i = tags.length - 1; i >= 0; i--) {
    const tag = tags[i]
    const lowerToken = tag.token.toLowerCase()
    const provider = AUTH_TAG_TO_PROVIDER[lowerToken]
    if (provider !== undefined) {
      providers.add(provider)
      cleaned = cleaned.slice(0, tag.start) + cleaned.slice(tag.end)
    } else if (lowerToken === DESIGN_TAG_TOKEN) {
      hasDesign = true
      cleaned = cleaned.slice(0, tag.start) + cleaned.slice(tag.end)
    }
    // Unknown tags pass through untouched.
  }

  cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  return { authProviders: Array.from(providers), hasDesign, cleanedText: cleaned }
}

/**
 * Detect known auth hashtags only (legacy API kept for callers that don't
 * care about `#design`). Use `preprocessHashtags` when you need both.
 */
export function detectAuthHashtags(text: string): AuthHashtagDetection {
  const pre = preprocessHashtags(text)
  return { providers: pre.authProviders, cleanedText: pre.cleanedText }
}
