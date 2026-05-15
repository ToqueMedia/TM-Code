import { Fragment, type ReactNode } from 'react'
import { tokens } from '@/theme/tokens'
import { slashCommandRegistry } from '../../services/agent/slashCommandRegistry'
import { extractHashtags } from '../../utils/hashtagParser'
import { HASHTAG_OPTIONS } from '../../services/agent/hashtagRegistry'

interface HighlightSegment {
  start: number
  end: number
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

/**
 * Render the prompt input value as styled spans, with TWO classes of token
 * highlighted:
 *
 *   1. Leading slash-command (only when the token matches a registered
 *      command). Position-locked: must start at index 0.
 *   2. Closed-vocabulary hashtags (`#auth-*` etc.) anywhere in the input,
 *      only when the tag exists in `HASHTAG_OPTIONS`. Whitespace-delimited.
 *
 * Plain string is returned when nothing matches — saves the caller a
 * Fragment in the common case.
 *
 * Why "registered tokens only": highlighting any `/word` or `#word` would
 * reward typos (`/aith`, `#aut-google` would both look correct). Coloring
 * only known tokens gives the user free validation that the name is
 * recognised by the IDE.
 */
export function renderHighlightedPrompt(value: string): ReactNode {
  const segments: HighlightSegment[] = []

  // 1. Leading slash command
  if (value.startsWith('/')) {
    const slashMatch = value.match(/^(\/\S+)(\s|$)/)
    if (slashMatch && slashCommandRegistry.getCommand(slashMatch[1])) {
      segments.push({ start: 0, end: slashMatch[1].length })
    }
  }

  // 2. Known hashtags (whitespace-delimited)
  const knownTags = new Set(HASHTAG_OPTIONS.map(o => o.tag))
  for (const tag of extractHashtags(value)) {
    if (knownTags.has(`#${tag.token}`)) {
      segments.push({ start: tag.start, end: tag.end })
    }
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
      <span key={`hl-${i}`} style={HIGHLIGHT_STYLE}>
        {value.slice(seg.start, seg.end)}
      </span>,
    )
    cursor = seg.end
  }
  if (cursor < value.length) out.push(value.slice(cursor))
  return <Fragment>{out}</Fragment>
}
