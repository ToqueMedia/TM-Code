import { slashCommandRegistry } from '../../services/agent/slashCommandRegistry'
import type { TranslationKey } from '@/i18n/translations'

type TFn = (key: TranslationKey) => string

// Pool de dicas de comandos para o Chat — espelha o terminalTips.ts, mas só com
// os slash commands universais (slashCommandRegistry), NÃO os comandos REPL
// exclusivos do Terminal (CMD_MODE_COMMANDS: /exit, /clear…), mais as
// afordâncias que existem no chat (@ para mencionar ficheiros, / para o menu).
// Cada comando vira uma dica individual (deduplicada por nome) para o catálogo
// ir sendo exposto aos poucos, sem despejar a lista inteira de uma vez.
export function buildChatTipPool(t: TFn): string[] {
  const seen = new Set<string>()
  const commandTips = slashCommandRegistry
    .listCommands()
    .filter(c => c.enabled)
    .map(c => `${c.name} — ${c.description}`)
    .filter(tipText => {
      const name = tipText.split(' ')[0]
      return seen.has(name) ? false : (seen.add(name), true)
    })
  const staticTips = [
    t('terminalMode.greeting.tipHelp'),
    `@ — ${t('terminalMode.greeting.mentionFile')}`,
  ]
  return [...commandTips, ...staticTips]
}
