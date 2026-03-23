import { executeInit } from './commands/initCommand'
import { executePlan } from './commands/planCommand'
import { executePaymentsStub } from './commands/paymentsCommand'

export interface SlashCommand {
  name: string
  description: string
  enabled: boolean
  execute: (args: string, projectPath: string) => Promise<void>
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
      name: '/payments',
      description: 'Load MoMenu payment skills (Multicaixa, E-kwanza, Referencia)',
      enabled: false,
      execute: executePaymentsStub,
    })
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
}

export const slashCommandRegistry = SlashCommandRegistry.getInstance()
