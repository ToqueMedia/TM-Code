import { executeInit } from './commands/initCommand'
import { executePlan } from './commands/planCommand'
import { executeDebug } from './commands/debugCommand'
import { executePayments } from './commands/paymentsCommand'

/** A canonical argument value the user can pick after the command name. */
export interface SlashCommandArg {
  /** Token appended to the input when the user picks this suggestion. */
  value: string
  /** One-line label shown in the autocomplete menu. */
  description: string
}

export interface SlashCommand {
  name: string
  description: string
  enabled: boolean
  execute: (args: string, projectPath: string) => Promise<void>
  /**
   * Optional canonical values the menu offers after the user types
   * `<cmd> ` (space). Suggestions are filtered by the partial word the
   * user is currently typing, and values already in the input are hidden
   * — so multi-arg chains work without showing duplicates.
   *
   * Free-form instructions appended after the last canonical value silently
   * dismiss the menu — there's nothing left to suggest.
   */
  argSuggestions?: SlashCommandArg[]
}

class SlashCommandRegistry {
  private static instance: SlashCommandRegistry
  private commands: Map<string, SlashCommand> = new Map()

  static getInstance(): SlashCommandRegistry {
    if (!SlashCommandRegistry.instance) {
      SlashCommandRegistry.instance = new SlashCommandRegistry()
      SlashCommandRegistry.instance.registerDefaults()
    }
    return SlashCommandRegistry.instance
  }

  private registerDefaults(): void {
    this.register({
      name: '/init',
      description: 'Initialize project — analyze structure, detect framework, generate TMS.md',
      enabled: true,
      execute: executeInit,
    })

    this.register({
      name: '/plan',
      description: 'Architect a feature — generate specs, get approval, create dev todo list',
      enabled: true,
      execute: executePlan,
    })

    this.register({
      name: '/debug',
      description: 'Debug an error or symptom — hypothesis-driven investigation with reasoning ON',
      enabled: true,
      execute: executeDebug,
    })

    this.register({
      name: '/payments',
      description: 'Integrate MoMenu Payments — fetches API skills and implements (MCX, E-kwanza, Referencia)',
      enabled: true,
      execute: executePayments,
    })

    // Note: `/auth` was removed in favour of the `#auth-email-password` and
    // `#auth-google` hashtag triggers — see `hashtagRegistry.ts` and the
    // hashtag detection in `usePromptBar.ts` / `useCmdPromptLogic.ts`.
  }

  register(command: SlashCommand): void {
    this.commands.set(command.name, command)
  }

  isSlashCommand(input: string): boolean {
    const cmd = input.trim().split(' ')[0]
    return this.commands.has(cmd)
  }

  getCommand(input: string): SlashCommand | null {
    const cmd = input.trim().split(' ')[0]
    return this.commands.get(cmd) || null
  }

  getArgs(input: string): string {
    const parts = input.trim().split(' ')
    return parts.slice(1).join(' ')
  }

  listCommands(): SlashCommand[] {
    return Array.from(this.commands.values())
  }

  filterCommands(prefix: string): SlashCommand[] {
    return this.listCommands().filter(cmd =>
      cmd.name.startsWith(prefix.toLowerCase())
    )
  }

  /**
   * Compute the argument autocomplete suggestions for the current input. Returns
   * an empty array when the input does not look like `<known-cmd> <partial>`,
   * the command has no `argSuggestions`, or every suggestion has already been
   * picked / no remaining suggestion matches the partial.
   *
   * The "partial" is the last whitespace-separated token.
   *
   * Free-form-text exit: as soon as the user types a token that is NOT one of
   * the known arg values, we treat them as having moved past the args list
   * into free-form instructions. The menu stays hidden from that point on,
   * even if a later partial happens to start with a known arg name.
   */
  getArgSuggestions(input: string): { command: SlashCommand; suggestions: SlashCommandArg[]; partial: string } | null {
    if (!input.startsWith('/') || !input.includes(' ')) return null
    const parts = input.split(/\s+/)
    const cmdName = parts[0]
    const cmd = this.commands.get(cmdName)
    if (!cmd || !cmd.argSuggestions || cmd.argSuggestions.length === 0) return null

    // Tokens between the command name and the cursor — last is the in-progress
    // word, the rest are committed.
    const argTokens = parts.slice(1)
    const partial = argTokens.length > 0 ? argTokens[argTokens.length - 1] : ''
    const previousTokens = argTokens.slice(0, -1).filter(Boolean)

    // Free-form exit: if any previous token isn't a known arg value, the user
    // has moved on to instructions. The menu must not return — they would
    // accidentally suggest replacing free-form text with a canonical arg.
    const validValues = new Set(cmd.argSuggestions.map(a => a.value))
    const hasFreeFormText = previousTokens.some(token => !validValues.has(token))
    if (hasFreeFormText) return null

    const committed = new Set(previousTokens)

    const suggestions = cmd.argSuggestions.filter(arg => {
      if (committed.has(arg.value)) return false
      if (partial && !arg.value.toLowerCase().startsWith(partial.toLowerCase())) return false
      return true
    })

    if (suggestions.length === 0) return null
    return { command: cmd, suggestions, partial }
  }
}

export const slashCommandRegistry = SlashCommandRegistry.getInstance()
