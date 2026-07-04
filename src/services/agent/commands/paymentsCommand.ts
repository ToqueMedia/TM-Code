import { useChatStore } from '../../../stores/chatStore'
import { t } from '../../../i18n'
import { runAgentWithCallbacks } from '../agentRunner'
import { logger } from '../../../utils/logger'
import { fetchAllMomenuSkills } from '../momenuSkills'
import type { SlashCommandMode } from '../slashCommandRegistry'

export async function executePayments(
  args: string,
  _projectPath: string,
  mode: SlashCommandMode = 'chat',
): Promise<void> {
  const chatStore = useChatStore.getState()

  if (!args.trim()) {
    chatStore.addSystemMessage(t('payments.usage'))
    return
  }

  // Fetch skills from GitHub (fire-and-forget — not persisted). Always pulls
  // the latest `main` revision; shared with the read_skill remote fallback via
  // momenuSkills.ts so both paths read the same source.
  let skillsContent: string
  try {
    skillsContent = await fetchAllMomenuSkills()
  } catch (err) {
    logger.error('payments', 'Failed to fetch skills:', err)
    chatStore.addSystemMessage(
      t('payments.loadFailed')
    )
    return
  }

  if (!skillsContent) {
    chatStore.addSystemMessage(
      t('payments.noneFound')
    )
    return
  }

  // Build the prompt: skills as context + user's request
  const prompt = `<payment_skills>
${skillsContent}
</payment_skills>

The developer wants to integrate MoMenu Payments into their project. Use the payment skills above as your implementation reference — they contain the complete API documentation, endpoints, payloads, webhooks, and testing setup.

Developer request: ${args}

Implement this following the exact API contracts in the skills. Use the project's existing patterns and framework.`

  // Run the agent with skills injected as context (fire-and-forget).
  // Status management is handled entirely by runAgentWithCallbacks — don't set it manually.
  await runAgentWithCallbacks(prompt, {
    addUserMessage: true,
    userMessageText: `/payments ${args}`,
    useConversationHistory: true,
    // Enable cwd-scoped tool execution when needed; otherwise file writes
    // may fail with "No project is open" if currentProject is not populated.
    cmdOnlyMode: mode === 'terminal',
  })
}
