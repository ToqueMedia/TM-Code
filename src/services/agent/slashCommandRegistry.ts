import { executeInit } from './commands/initCommand'
import { executePlan } from './commands/planCommand'
import { executeDebug } from './commands/debugCommand'
import { executePayments } from './commands/paymentsCommand'
import { executeE2E } from './commands/e2eCommand'
import { executeReview } from './commands/reviewCommand'
import { executeCompact } from './commands/compactCommand'
// /speed RETIRADO da UI em 2026-07-16 (decisão do user: guardar como código
// morto para reativação futura). Para o repor: descomentar estes imports e o
// bloco de registo em registerDefaults(), voltar a montar o TmSpeedIndicator
// na MinimalTitleBar e desligar TM_SPEED_RETIRED no tmSpeedStore.
// import { executeSpeed } from './commands/speedCommand'
// import { useTmSpeedStore, isSpeedModelEligible } from '../../stores/tmSpeedStore'
import type { UserPlanName } from '../../stores/billingStore'
import { t, type TranslationKey } from '../../i18n'

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
  /**
   * Inline placeholder hint rendered as ghost text in the prompt after the
   * command name, e.g. `/plan [feature to architect]`. Shown while the
   * input is just the command (with or without trailing space) and no
   * argument has been typed yet; disappears as soon as the user starts
   * typing args. Uses bracket syntax so the user can read it as a slot
   * rather than literal content to copy.
   */
  argHint?: string
  /**
   * When true, the command is unavailable on the free (Explorer) plan.
   * The slash menu marks it with a "Pro" badge and disables the row;
   * the execute function still surfaces the upgrade message if reached
   * by another path (e.g. typing the full command and pressing enter).
   */
  requiresPaidPlan?: boolean
  /** Optional stricter plan allow-list for plan-gated commands. */
  allowedPlans?: UserPlanName[]
  /** Optional i18n key for a custom plan-gate message. */
  planGateMessageKey?: TranslationKey
  /**
   * When true AND requiresPaidPlan is also true, the generic paid-plan
   * guard in executePrompt is skipped so the command's own execute()
   * function can show a specific message (e.g. /speed shows
   * "speed.planRequired" instead of the generic "paid feature" text).
   * The "Pro" badge still renders in the menu.
   */
  usesOwnPlanGate?: boolean
  /**
   * Defaults to true. Account-level commands such as `/speed` work before a
   * project is open.
   */
  requiresProject?: boolean
  /**
   * Gate de visibilidade dinâmico, avaliado em CADA listCommands() (menus,
   * dicas do greeting). `false` → o comando não aparece em lado nenhum, mas
   * `getCommand()` continua a resolvê-lo para quem o digitar por extenso —
   * o execute() do comando é responsável pela mensagem de indisponibilidade
   * nesse caso. Usado pelo /speed: oculto quando o modelo ativo não é a
   * família MiMo V2.5 Pro (o speed é uma variante desse modelo).
   */
  visibleWhen?: () => boolean
}

export function isSlashCommandAllowedForPlan(command: SlashCommand, plan: UserPlanName): boolean {
  if (command.allowedPlans) return command.allowedPlans.includes(plan)
  if (command.requiresPaidPlan) return plan !== 'explorer'
  return true
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
      description: t('slashCmd.init.desc'),
      enabled: true,
      execute: executeInit,
      argHint: '[optional: extra context for the analysis]',
    })

    this.register({
      name: '/plan',
      description: t('slashCmd.plan.desc'),
      enabled: true,
      execute: executePlan,
      argHint: '[feature or full app to plan]',
    })

    this.register({
      name: '/debug',
      description: t('slashCmd.debug.desc'),
      enabled: true,
      execute: executeDebug,
      argHint: '[error message or symptom]',
    })

    this.register({
      name: '/payments',
      description: t('slashCmd.payments.desc'),
      enabled: true,
      execute: executePayments,
      argHint: '[provider: mcx | e-kwanza | referencia]',
    })

    this.register({
      name: '/te2e',
      description: t('slashCmd.te2e.desc'),
      enabled: true,
      execute: executeE2E,
      requiresPaidPlan: true,
      argHint: '[what to validate]',
    })

    this.register({
      name: '/review',
      description: t('slashCmd.review.desc'),
      enabled: true,
      execute: executeReview,
      argHint: '[optional: focus area or path]',
    })

    this.register({
      name: '/compact',
      description: t('slashCmd.compact.desc'),
      enabled: true,
      execute: executeCompact,
      argHint: '[optional: custom instructions for summarization]',
    })

    // /speed RETIRADO em 2026-07-16 — código morto deliberado, será reusado.
    // A implementação (speedCommand.ts, tmSpeedStore.ts, TmSpeedIndicator.tsx,
    // header X-TM-Speed no agentService) fica intacta; só o registo, o badge da
    // titlebar e o honrar do flag de perfil (TM_SPEED_RETIRED) estão desligados.
    // this.register({
    //   name: '/speed',
    //   description: t('slashCmd.speed.desc'),
    //   enabled: true,
    //   execute: executeSpeed,
    //   requiresPaidPlan: true,
    //   allowedPlans: ['pro', 'max'],
    //   planGateMessageKey: 'speed.planRequired',
    //   requiresProject: false,
    //   // Oculto quando o modelo ativo não é a família MiMo V2.5 Pro — o TM
    //   // Speed é uma variante desse modelo; com outro modelo publicado na
    //   // config ativa o toggle seria um no-op enganador (2026-06-11).
    //   visibleWhen: () => isSpeedModelEligible(useTmSpeedStore.getState().activeModelId),
    // })

    // Note: `/auth` (and later the `#auth-*` hashtag triggers that replaced
    // it) were removed with the MANAGED-PLATFORM layer — managed auth
    // provisioning lives in TM Code Web. See `hashtagRegistry.ts`.
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
    return Array.from(this.commands.values()).filter(cmd => {
      try {
        return cmd.visibleWhen ? cmd.visibleWhen() : true
      } catch {
        // Um gate que rebenta nunca pode esconder/partir o menu inteiro.
        return true
      }
    })
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
