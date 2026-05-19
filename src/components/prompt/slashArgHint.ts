import { slashCommandRegistry, type SlashCommand } from '../../services/agent/slashCommandRegistry'

/**
 * Resolve the inline argument hint to render as ghost text after a slash
 * command. Returns `null` for any input shape where the hint shouldn't
 * appear:
 *   - input doesn't start with `/`
 *   - command not in the registry (no exact-name match)
 *   - the user has already typed args (command followed by non-empty token)
 *   - the command declares no `argHint`
 *
 * Used by both `PromptTextarea` (chat mode) and `CmdModePromptInput`
 * (terminal mode) so the UX parity is mechanical, not duplicated.
 */
export function resolveInlineArgHint(value: string): string | null {
  if (!value.startsWith('/')) return null
  // Strip a single trailing space — `/plan ` should still hint just like
  // `/plan`. But `/plan x` means args are starting; no hint.
  const trimmed = value.replace(/ $/, '')
  if (trimmed.includes(' ')) return null
  // Use registry's getCommand — match-exact, no startsWith ambiguity.
  const cmd: SlashCommand | null = slashCommandRegistry.getCommand(trimmed)
  return cmd?.argHint ?? null
}
