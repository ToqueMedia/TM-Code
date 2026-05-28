import { useChatStore } from '@/stores/chatStore'
import AgentService from '../agentService'
import { useAgentStore } from '@/stores/agentStore'
import type { CompactProgressEvent } from '@/types/agent'
import type { SlashCommandMode } from '../slashCommandRegistry'
import { t } from '@/i18n/useTranslation'

export async function executeCompact(
  args: string,
  _projectPath: string,
  _mode: SlashCommandMode = 'chat',
): Promise<void> {
  const chatStore = useChatStore.getState()
  const agentStore = useAgentStore.getState()
  const agentService = AgentService.getInstance()

  // Guard: check if agent is currently running
  if (agentService.isAgentRunning()) {
    chatStore.addSystemMessage(t('chat.compact.busy'), 'warn')
    return
  }

  // Guard: check minimum message count
  const history = chatStore.conversationHistory
  if (history.length < 4) {
    chatStore.addSystemMessage(t('chat.compact.notEnough'), 'warn')
    return
  }

  const isPartial = args.trim().toLowerCase() === 'partial'
  const customInstructions = isPartial ? undefined : (args.trim() || undefined)

  // Progress callback — drives compactPhase in agentStore so the UI
  // shows phased status labels (pre-hooks, compressing, post-hooks).
  const onProgress = (event: CompactProgressEvent) => {
    if (event.type === 'hooks_start') {
      agentStore.setCompactPhase(event.hookType === 'pre_compact' ? 'hooks_pre' : 'hooks_post')
    } else if (event.type === 'compact_start') {
      agentStore.setCompactPhase('compressing')
    } else if (event.type === 'compact_end') {
      agentStore.setCompactPhase('idle')
    }
  }

  try {
    agentStore.setStatus('compressing')
    if (isPartial) {
      await agentService.runPartialCompact(undefined, onProgress)
    } else {
      await agentService.runManualCompact(customInstructions, onProgress)
    }
    agentStore.setStatus('idle')
  } catch (err) {
    agentStore.setCompactPhase('idle')
    agentStore.setStatus('idle')
    chatStore.addSystemMessage(
      `Erro na compressão: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
  }
}
