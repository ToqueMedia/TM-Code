import { useChatStore } from '../../../stores/chatStore'
import { useTmSpeedStore } from '../../../stores/tmSpeedStore'
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
