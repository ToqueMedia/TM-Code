import { useChatStore } from '@/stores/chatStore'
import AgentService from '../agentService'
import { useAgentStore } from '@/stores/agentStore'
import type { SlashCommandMode } from '../slashCommandRegistry'

export async function executeCompact(
  args: string,
  _projectPath: string,
  _mode: SlashCommandMode = 'chat',
): Promise<void> {
  const chatStore = useChatStore.getState()
  const agentService = AgentService.getInstance()

  // Guard: check if agent is currently running
  if (agentService.isAgentRunning()) {
    chatStore.addSystemMessage('Não é possível comprimir enquanto o agente está a processar.', 'warn')
    return
  }

  // Guard: check minimum message count
  const history = chatStore.conversationHistory
  if (history.length < 4) {
    chatStore.addSystemMessage('Poucas mensagens para comprimir.', 'warn')
    return
  }

  const customInstructions = args.trim() || undefined

  try {
    useAgentStore.getState().setStatus('compressing')
    await agentService.runManualCompact(customInstructions)
    useAgentStore.getState().setStatus('idle')
  } catch (err) {
    useAgentStore.getState().setStatus('idle')
    chatStore.addSystemMessage(
      `Erro na compressão: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
  }
}
