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
 * Used by both prompt input surfaces so the UX parity is mechanical,
 * not duplicated.
 *
 * @param extraCommands - Optional additional commands to check beyond the
 *   global registry (e.g. session-control commands).
 */
export function resolveInlineArgHint(value: string, extraCommands?: SlashCommand[]): string | null {
  if (!value.startsWith('/')) return null
  // Strip a single trailing space — `/plan ` should still hint just like
  // `/plan`. But `/plan x` means args are starting; no hint.
  const trimmed = value.replace(/ $/, '')
  if (trimmed.includes(' ')) return null
  // Use registry's getCommand — match-exact, no startsWith ambiguity.
  const cmd: SlashCommand | null = slashCommandRegistry.getCommand(trimmed)
    ?? (extraCommands?.find(c => c.name === trimmed) ?? null)
  return cmd?.argHint ?? null
}
