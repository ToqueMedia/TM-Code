import { CMD_MODE_COMMANDS } from '../../services/agent/cmdModeCommands'
import { slashCommandRegistry } from '../../services/agent/slashCommandRegistry'
import type { TranslationKey } from '@/i18n/translations'

type TFn = (key: TranslationKey) => string

// Pool de dicas partilhado entre o greeting (uma dica estática por sessão) e
// as dicas rotativas que aparecem durante o trabalho do agente (TerminalWorkingTips).
// Cada comando vira uma dica individual (deduplicado por nome) + as dicas fixas
// de navegação — assim o catálogo inteiro vai sendo exposto sem despejar a lista
// completa de uma vez.
export function buildTipPool(t: TFn): string[] {
  const commandTips = [...CMD_MODE_COMMANDS, ...slashCommandRegistry.listCommands()]
    .filter(c => c.enabled)
    .map(c => `${c.name} — ${c.description}`)
  const seen = new Set<string>()
  const unique = commandTips.filter(tipText => {
    const name = tipText.split(' ')[0]
    return seen.has(name) ? false : (seen.add(name), true)
  })
  const staticTips = [
    t('terminalMode.greeting.tipHelp'),
    `↑ ↓ — ${t('terminalMode.greeting.navigateHistory')}`,
    `@ — ${t('terminalMode.greeting.mentionFile')}`,
    `! — ${t('terminalMode.greeting.runShell')}`,
  ]
  return [...unique, ...staticTips]
}
