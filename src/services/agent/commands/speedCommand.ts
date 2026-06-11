import { useChatStore } from '../../../stores/chatStore'
import { useTmSpeedStore, isSpeedModelEligible } from '../../../stores/tmSpeedStore'
import { useBillingStore } from '../../../stores/billingStore'
import type { UserPlanName } from '../../../stores/billingStore'
import FirebaseAuthService from '../../auth/firebaseAuth'
import { t } from '../../../i18n'
import type { SlashCommandMode } from '../slashCommandRegistry'

/** Plans that are allowed to toggle TM Speed. */
const SPEED_ALLOWED_PLANS: UserPlanName[] = ['pro', 'max']

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

  // Gate: only pro / max plans may toggle TM Speed
  const currentPlan = useBillingStore.getState().plan
  if (!SPEED_ALLOWED_PLANS.includes(currentPlan)) {
    chatStore.addSystemMessage(t('speed.planRequired'))
    return
  }

  // Gate por modelo: o speed é uma variante do MiMo V2.5 Pro. O comando fica
  // oculto nos menus quando o modelo ativo é outro (visibleWhen no registry),
  // mas quem o digitar por extenso recebe a explicação em vez de um no-op.
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
