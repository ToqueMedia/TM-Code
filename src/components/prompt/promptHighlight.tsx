import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { tokens } from '@/theme/tokens'
import { slashCommandRegistry } from '../../services/agent/slashCommandRegistry'
import { extractHashtags } from '../../utils/hashtagParser'
import { extractMentions } from '../../utils/mentionParser'
import { HASHTAG_OPTIONS } from '../../services/agent/hashtagRegistry'

interface HighlightSegment {
  start: number
  end: number
  kind: 'token' | 'mention'
}

// Color-only highlight — DO NOT add fontWeight, letter-spacing, or any other
// metric-changing property here. The overlay sits behind a transparent
// textarea, and the textarea cannot bold/italicise sub-ranges. So if the
// overlay renders a `#hashtag` at weight 600 while the textarea renders the
// same chars at weight 400, the bold glyphs are physically wider in the
// overlay → everything after the highlighted span drifts right → wrap
// columns and caret position diverge → on long pastes (or Cmd+A when the
// textarea's text becomes opaque under selection) the user sees ghost
// glyphs and feels editing "from a distance". Color-only stays width-safe.
const HIGHLIGHT_STYLE = { color: tokens.colors.accent.primary }

// @mention chip — PAINT-ONLY decorations (background + radius + color).
// Same width-safety contract as HIGHLIGHT_STYLE: padding, borders or inline
// icons would shift overlay glyphs away from the textarea's caret, so the
// pill hugs the exact glyph run. The trailing '/' the composer keeps on
// directory chips stays visible inside the pill.
const MENTION_CHIP_STYLE: CSSProperties = {
  color: tokens.colors.accent.primary,
  background: 'rgba(254, 16, 99, 0.10)',
  borderRadius: '4px',
  boxShadow: 'inset 0 0 0 1px rgba(254, 16, 99, 0.18)',
}

/**
 * Render the prompt input value as styled spans, with THREE classes of token
 * highlighted:
 *
 *   1. Leading slash-command (only when the token matches a registered
 *      command). Position-locked: must start at index 0.
 *   2. Closed-vocabulary hashtags (`#auth-*` etc.) anywhere in the input,
 *      only when the tag exists in `HASHTAG_OPTIONS`. Whitespace-delimited.
 *   3. `@mentions` anywhere in the input — rendered as a pill. Unlike the
 *      other two there is no closed vocabulary to validate against (the
 *      mention may be mid-typing with the autocomplete open), so every
 *      well-formed mention token gets the chip.
 *
 * Plain string is returned when nothing matches — saves the caller a
 * Fragment in the common case.
 *
 * Why "registered tokens only" (slash/hashtag): highlighting any `/word` or
 * `#word` would reward typos (`/aith`, `#aut-google` would both look
 * correct). Coloring only known tokens gives the user free validation that
 * the name is recognised by the IDE.
 */
export function renderHighlightedPrompt(value: string): ReactNode {
  const segments: HighlightSegment[] = []

  // 1. Leading slash command
  if (value.startsWith('/')) {
    const slashMatch = value.match(/^(\/\S+)(\s|$)/)
    if (slashMatch && slashCommandRegistry.getCommand(slashMatch[1])) {
      segments.push({ start: 0, end: slashMatch[1].length, kind: 'token' })
    }
  }

  // 2. Known hashtags (whitespace-delimited)
  const knownTags = new Set(HASHTAG_OPTIONS.map(o => o.tag))
  for (const tag of extractHashtags(value)) {
    if (knownTags.has(`#${tag.token}`)) {
      segments.push({ start: tag.start, end: tag.end, kind: 'token' })
    }
  }

  // 3. @mentions (name-only chips or full paths)
  for (const mention of extractMentions(value)) {
    segments.push({ start: mention.start, end: mention.end, kind: 'mention' })
  }

  if (segments.length === 0) return value

  // Stable in-place sort; no overlap is possible because each segment is
  // whitespace-anchored so they never share a character.
  segments.sort((a, b) => a.start - b.start)

  const out: ReactNode[] = []
  let cursor = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (cursor < seg.start) out.push(value.slice(cursor, seg.start))
    out.push(
      <span key={`hl-${i}`} style={seg.kind === 'mention' ? MENTION_CHIP_STYLE : HIGHLIGHT_STYLE}>
        {value.slice(seg.start, seg.end)}
      </span>,
    )
    cursor = seg.end
  }
  if (cursor < value.length) out.push(value.slice(cursor))
  return <Fragment>{out}</Fragment>
}
