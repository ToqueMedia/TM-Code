/**
 * promptHighlight — the transparent-textarea overlay contract.
 *
 * The overlay renders the prompt's visible glyphs BEHIND a transparent
 * textarea; caret alignment only holds while every decoration is
 * paint-only. These tests pin that contract for the @mention chip:
 *   - every well-formed mention becomes a pill span around the exact
 *     glyph run (`@foo.ts`, `@components/`),
 *   - the chip style contains NO metric-changing property (padding,
 *     font-weight, letter-spacing…), only paint (color/background/radius),
 *   - plain text and unregistered slash/hashtag tokens stay untouched.
 *
 * The registries are mocked — their real modules pull the whole command
 * surface, and the overlay only needs getCommand/HASHTAG_OPTIONS shape.
 */
jest.mock('../../../services/agent/slashCommandRegistry', () => ({
  slashCommandRegistry: {
    getCommand: (name: string) => (name === '/plan' ? { name } : undefined),
  },
}))
jest.mock('../../../services/agent/hashtagRegistry', () => ({
  HASHTAG_OPTIONS: [{ tag: '#design' }],
}))

import { renderToStaticMarkup } from 'react-dom/server'
import { renderHighlightedPrompt } from '../promptHighlight'

const CHIP_BG = 'background:rgba(254, 16, 99, 0.10)'

function mentionSpans(markup: string): string[] {
  return markup.match(/<span[^>]*>[^<]*<\/span>/g) ?? []
}

describe('renderHighlightedPrompt — @mention chips', () => {
  it('wraps a mention token in a pill span', () => {
    const markup = renderToStaticMarkup(
      <>{renderHighlightedPrompt('fix @foo.ts now')}</>,
    )
    const spans = mentionSpans(markup)
    expect(spans.some(s => s.includes('>@foo.ts</span>'))).toBe(true)
    expect(spans.some(s => s.includes(CHIP_BG))).toBe(true)
  })

  it('keeps the directory trailing slash inside the pill', () => {
    const markup = renderToStaticMarkup(
      <>{renderHighlightedPrompt('explore @components/ first')}</>,
    )
    expect(markup).toContain('>@components/</span>')
  })

  it('chips multiple mentions independently', () => {
    const markup = renderToStaticMarkup(
      <>{renderHighlightedPrompt('@a.ts and @b.ts')}</>,
    )
    expect(markup).toContain('>@a.ts</span>')
    expect(markup).toContain('>@b.ts</span>')
  })

  it('does not treat mid-word @ as a mention (emails stay plain)', () => {
    const result = renderHighlightedPrompt('mail user@host.com today')
    expect(result).toBe('mail user@host.com today')
  })

  it('chip style is paint-only — no metric-changing properties', () => {
    const markup = renderToStaticMarkup(
      <>{renderHighlightedPrompt('see @foo.ts')}</>,
    )
    const chip = mentionSpans(markup).find(s => s.includes('>@foo.ts</span>'))
    expect(chip).toBeDefined()
    expect(chip).toContain('border-radius:4px')
    for (const forbidden of ['padding', 'font-weight', 'letter-spacing', 'margin', 'border:']) {
      expect(chip).not.toContain(forbidden)
    }
  })

  it('returns the plain string when nothing matches', () => {
    expect(renderHighlightedPrompt('plain text')).toBe('plain text')
    // Unregistered slash/hashtag tokens stay uncoloured (typo validation).
    expect(renderHighlightedPrompt('/aith go')).toBe('/aith go')
    expect(renderHighlightedPrompt('#not-a-known-tag')).toBe('#not-a-known-tag')
  })

  it('still colours the registered slash command and hashtag alongside chips', () => {
    const markup = renderToStaticMarkup(
      <>{renderHighlightedPrompt('/plan with #design and @foo.ts')}</>,
    )
    expect(markup).toContain('>/plan</span>')
    expect(markup).toContain('>#design</span>')
    expect(markup).toContain('>@foo.ts</span>')
  })
})
