import { useChatStore } from '../../../stores/chatStore'
import { useTmSpeedStore, isSpeedModelEligible } from '../../../stores/tmSpeedStore'
import FirebaseAuthService from '../../auth/firebaseAuth'
import { t } from '../../../i18n'
import type { SlashCommandMode } from '../slashCommandRegistry'

export async function executeSpeed(
  args: string,
  _projectPath: string,
  _mode: SlashCommandMode = 'chat',
): Promise<void> {
  const chatStore = useChatStore.getState()

  if (args.trim()) {
    chatStore.addSystemMessage(t('speed.usage'))
    return
  }

  // SEM gate de plano aqui: o dispatcher de slash commands (usePromptBar.ts /
  // useCmdPromptLogic.ts) já bloqueia não-Pro/Max ANTES de executar, via
  // `requiresPaidPlan` + `allowedPlans: ['pro','max']` no registry. Duplicar a
  // verificação aqui era código inalcançável e uma 2ª cópia da lista a drift.
  //
  // Gate por modelo (preocupação ÚNICA do comando): o speed é uma variante do
  // MiMo V2.5 Pro. O comando fica oculto nos menus quando o modelo ativo é
  // outro (visibleWhen no registry), mas quem o digitar por extenso recebe a
  // explicação em vez de um no-op — por isso este gate mantém-se.
  if (!isSpeedModelEligible(useTmSpeedStore.getState().activeModelId)) {
    chatStore.addSystemMessage(t('speed.modelRequired'))
    return
  }

  const current = useTmSpeedStore.getState().enabled
  const next = !current

  try {
    await FirebaseAuthService.getInstance().setTmSpeedEnabled(next)
    chatStore.addSystemMessage(next ? t('speed.enabled') : t('speed.disabled'))
  } catch (err) {
    chatStore.addSystemMessage(
      t('speed.error').replace('{error}', err instanceof Error ? err.message : String(err)),
      'error',
    )
  }
}
