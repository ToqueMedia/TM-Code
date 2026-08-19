import { useChatStore } from '../../../stores/chatStore'
import { t } from '../../../i18n'
import { runAgentWithCallbacks } from '../agentRunner'
import AgentService from '../agentService'
import { buildDebugPrompt } from './debugPrompt'

/**
 * `/debug <symptom>` — nudge the main agent to investigate before editing.
 *
 * Reuses the user's coder model and their reasoning-effort selector.
 * `X-Request-Type=debug` is a sticky label for this run, not a thinking
 * switch (the worker has no debug sidecar).
 */
export async function executeDebug(
  args: string,
  projectPath: string,
): Promise<void> {
  const chatStore = useChatStore.getState()

  if (!args.trim()) {
    chatStore.addSystemMessage(
      t('debug.usage')
    )
    return
  }

  const agentService = AgentService.getInstance()
  agentService.setRequestType('debug')
  try {
    await runAgentWithCallbacks(buildDebugPrompt(args, projectPath), {
      addUserMessage: true,
      userMessageText: `/debug ${args}`,
    })
  } finally {
    agentService.setRequestType(null)
  }
}
