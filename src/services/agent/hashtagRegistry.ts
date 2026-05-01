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
  { tag: '#auth-email-password', description: 'Email + password auth (GIP proxy + Identity Toolkit)' },
  { tag: '#auth-google',         description: 'Google sign-in via Google Identity Services (GIP proxy)' },
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

export interface AuthHashtagDetection {
  /** Distinct providers signalled by the recognised tags. */
  providers: Provider[]
  /** Original text minus the recognised auth hashtags (whitespace collapsed). */
  cleanedText: string
}

/**
 * Detect known auth hashtags in `text`. Strips them from the text so the
 * user-visible message reads naturally without the `#tag` noise. Returns
 * `{ providers: [], cleanedText: text }` when none are found.
 *
 * Hashtags must be whitespace-delimited (same rule as the parser): a `#`
 * mid-word doesn't trigger.
 */
export function detectAuthHashtags(text: string): AuthHashtagDetection {
  const tags = extractHashtags(text)
  if (tags.length === 0) {
    return { providers: [], cleanedText: text }
  }

  const providers = new Set<Provider>()
  // Walk backwards so removing earlier tags doesn't shift later indices.
  let cleaned = text
  for (let i = tags.length - 1; i >= 0; i--) {
    const tag = tags[i]
    const provider = AUTH_TAG_TO_PROVIDER[tag.token.toLowerCase()]
    if (provider !== undefined) {
      providers.add(provider)
      cleaned = cleaned.slice(0, tag.start) + cleaned.slice(tag.end)
    }
  }

  cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  return { providers: Array.from(providers), cleanedText: cleaned }
}
