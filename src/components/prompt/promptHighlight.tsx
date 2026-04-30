import { Fragment, type ReactNode } from 'react'
import { tokens } from '@/theme/tokens'
import { slashCommandRegistry } from '../../services/agent/slashCommandRegistry'

/**
 * Render the prompt input value as styled spans, with the leading slash-command
 * token highlighted when it matches a registered command. Returns the raw
 * string when no highlight applies — caller can render either output the
 * same way, simplifying the overlay JSX.
 *
 * Why "registered command" only: highlighting any `/word` would reward typos
 * (`/aith` looks correct in pink). Coloring only known commands gives the
 * user free validation that the name is recognized.
 */
export function renderHighlightedPrompt(value: string): ReactNode {
  if (!value.startsWith('/')) return value
  const match = value.match(/^(\/\S+)(\s|$)/)
  if (!match) return value
  const token = match[1]
  if (!slashCommandRegistry.getCommand(token)) return value
  return (
    <Fragment>
      <span style={{ color: tokens.colors.accent.primary, fontWeight: 600 }}>{token}</span>
      {value.slice(token.length)}
    </Fragment>
  )
}
