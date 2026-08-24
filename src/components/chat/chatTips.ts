import { slashCommandRegistry } from '../../services/agent/slashCommandRegistry'
import type { TranslationKey } from '@/i18n/translations'

type TFn = (key: TranslationKey) => string

// Pool de dicas para o Chat: os slash commands universais (slashCommandRegistry
// — comandos retirados desaparecem daqui sozinhos) + dicas estáticas de
// FUNCIONALIDADES da IDE (chatTips.* em translations.ts). Cada entrada vira uma
// dica individual para o catálogo ir sendo exposto aos poucos, sem despejar a
// lista inteira de uma vez. REGRA DE MANUTENÇÃO: uma dica só entra se a
// afordância existir MESMO na UI actual — feature removida ⇒ dica removida
// (chatTips.* em translations.ts é a lista canónica).
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
    t('chatTips.steer'),
    t('chatTips.newTask'),
    t('chatTips.stopQueue'),
    t('chatTips.checkpoints'),
    t('chatTips.terminal'),
    t('chatTips.editor'),
    t('chatTips.devServer'),
    t('chatTips.preview'),
    t('chatTips.images'),
    t('chatTips.byok'),
    t('chatTips.multiWindow'),
    t('chatTips.sessions'),
    t('chatTips.mcp'),
    t('chatTips.improvePrompt'),
    t('chatTips.skills'),
    t('chatTips.teamChat'),
    t('chatTips.sourceControl'),
    t('chatTips.webFetch'),
    t('chatTips.designCopy'),
  ]
  return [...commandTips, ...staticTips]
}
