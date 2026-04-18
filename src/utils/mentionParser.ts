// Shared @mention parser. Single source of truth for detection and extraction
// across CMD mode, chat prompt, and the server-side resolver. Unicode-safe.

// A mention token accepts:
//   - Unicode letters and numbers (\p{L}\p{N})
//   - Path separators: / \
//   - Common filename chars: . _ - + ~ ! $ % # & ' ( ) [ ] @
// Whitespace and control chars terminate the token.
//
// Note: leading '@' is the trigger and is matched separately — it is NOT part
// of MENTION_CHAR so we don't greedily eat a second @ inside a path.
const MENTION_CHAR_RE = /[\p{L}\p{N}._+~!$%#&'()\-[\]/\\]/u

export function isMentionChar(ch: string): boolean {
  return MENTION_CHAR_RE.test(ch)
}

export interface MentionAtCursor {
  atIndex: number
  query: string
}

/**
 * Scan backward from `cursorPos` to find an active `@mention` token whose
 * body lies between the '@' and the cursor.
 *
 * Returns `null` when:
 *   - the cursor is not inside a mention token,
 *   - the '@' is preceded by a non-whitespace char (mid-word, e.g. an email),
 *   - a non-mention char was encountered before reaching an '@'.
 */
export function findMentionAtCursor(text: string, cursorPos: number): MentionAtCursor | null {
  const bound = Math.min(cursorPos, text.length)
  for (let i = bound - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') {
      if (i === 0 || /\s/.test(text[i - 1])) {
        return { atIndex: i, query: text.slice(i + 1, bound) }
      }
      return null
    }
    if (!isMentionChar(ch)) return null
  }
  return null
}

/**
 * Given the index AFTER the '@', advance to the end of the current mention
 * token (first non-mention char or EOL). Used when inserting a selected
 * completion — we must replace up to the token end, not merely up to the
 * cursor, or any trailing chars the user had typed would survive as garbage.
 */
export function findMentionTokenEnd(text: string, afterAtIndex: number): number {
  for (let i = afterAtIndex; i < text.length; i++) {
    if (!isMentionChar(text[i])) return i
  }
  return text.length
}

export interface ExtractedMention {
  /** The raw token body (without the leading '@'). May end with '/' for dirs. */
  token: string
  /** Offset of the '@' in the original string. */
  start: number
  /** Offset of the first char after the token. */
  end: number
}

/**
 * Extract all @-mentions from `text`. A mention starts with '@' that is either
 * at string start or preceded by whitespace, and continues while characters
 * satisfy `isMentionChar`. A trailing '/' is preserved so downstream code can
 * disambiguate directory mentions.
 */
export function extractMentions(text: string): ExtractedMention[] {
  const results: ExtractedMention[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '@' && (i === 0 || /\s/.test(text[i - 1]))) {
      let j = i + 1
      while (j < text.length && isMentionChar(text[j])) j++
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
