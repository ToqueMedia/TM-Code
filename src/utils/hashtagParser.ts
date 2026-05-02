// Shared #hashtag parser. Mirrors mentionParser but for the autocomplete
// system that surfaces canonical "skill tokens" the user can drop into a
// prompt (e.g. `#auth-email-password`, `#auth-google`).
//
// Hashtags are a closed vocabulary: the menu only suggests known tokens, and
// only those known tokens are detected at submit-time. Free-form text that
// happens to start with `#` (e.g. issue references like `#1234`) is ignored
// — the registry decides what counts.

// A hashtag token accepts ASCII alphanumerics + `-` only. Tokens are short,
// kebab-case, and never contain unicode/path/punctuation. Any other char
// terminates the token.
const HASHTAG_CHAR_RE = /[A-Za-z0-9-]/

function isHashtagChar(ch: string): boolean {
  return HASHTAG_CHAR_RE.test(ch)
}

export interface HashtagAtCursor {
  hashIndex: number
  query: string
}

/**
 * Scan backward from `cursorPos` to find an active `#tag` whose body lies
 * between the '#' and the cursor.
 *
 * Returns `null` when:
 *   - the cursor is not inside a hashtag token,
 *   - the '#' is preceded by a non-whitespace char (mid-word),
 *   - a non-hashtag char was encountered before reaching a '#'.
 */
export function findHashtagAtCursor(text: string, cursorPos: number): HashtagAtCursor | null {
  const bound = Math.min(cursorPos, text.length)
  for (let i = bound - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '#') {
      if (i === 0 || /\s/.test(text[i - 1])) {
        return { hashIndex: i, query: text.slice(i + 1, bound) }
      }
      return null
    }
    if (!isHashtagChar(ch)) return null
  }
  return null
}

/**
 * Given the index AFTER the '#', advance to the end of the current hashtag
 * token. Used when inserting a selected completion — replace up to the token
 * end so trailing chars the user had typed don't survive as garbage.
 */
export function findHashtagTokenEnd(text: string, afterHashIndex: number): number {
  for (let i = afterHashIndex; i < text.length; i++) {
    if (!isHashtagChar(text[i])) return i
  }
  return text.length
}

export interface ExtractedHashtag {
  /** The raw token body (without the leading '#'). */
  token: string
  /** Offset of the '#' in the original string. */
  start: number
  /** Offset of the first char after the token. */
  end: number
}

/**
 * Extract all `#hashtag` tokens from `text`. A hashtag starts with '#' that is
 * either at string start or preceded by whitespace, and continues while
 * characters satisfy `isHashtagChar`.
 */
export function extractHashtags(text: string): ExtractedHashtag[] {
  const results: ExtractedHashtag[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      let j = i + 1
      while (j < text.length && isHashtagChar(text[j])) j++
      if (j > i + 1) {
        results.push({ token: text.slice(i + 1, j), start: i, end: j })
        i = j
        continue
      }
    }
    i++
  }
  return results
}
