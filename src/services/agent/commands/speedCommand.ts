import { useChatStore } from '../../../stores/chatStore'
import { useTmSpeedStore } from '../../../stores/tmSpeedStore'
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
