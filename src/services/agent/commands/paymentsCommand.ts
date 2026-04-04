import { useChatStore } from '../../../stores/chatStore'
import { useAgentStore } from '../../../stores/agentStore'
import { runAgentWithCallbacks } from '../agentRunner'
import { logger } from '../../../utils/logger'

const SKILLS_BASE = 'https://raw.githubusercontent.com/ithustle/momenu-skills/main/skills'

const SKILL_FILES = [
  { name: 'mom-factura-payments', files: ['SKILL.md', 'references/STATUS-POLLING.md'] },
  { name: 'mom-factura-webhooks', files: ['SKILL.md'] },
  { name: 'mom-factura-testing', files: ['SKILL.md'] },
]

async function fetchSkillContent(skillName: string, file: string): Promise<string | null> {
  try {
    const url = `${SKILLS_BASE}/${skillName}/${file}`
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

async function fetchAllSkills(): Promise<string> {
  const parts: string[] = []

  for (const skill of SKILL_FILES) {
    for (const file of skill.files) {
      const content = await fetchSkillContent(skill.name, file)
      if (content) {
        const label = file === 'SKILL.md' ? skill.name : `${skill.name}/${file}`
        parts.push(`<skill name="${label}">\n${content}\n</skill>`)
      }
    }
  }

  return parts.join('\n\n')
}

export async function executePayments(args: string, _projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()

  if (!args.trim()) {
    chatStore.addSystemMessage(
      'Usage: /payments <what you want to implement>\n\n' +
      'Examples:\n' +
      '  /payments integrate Multicaixa Express\n' +
      '  /payments add all payment methods with webhooks\n' +
      '  /payments setup testing environment for payments'
    )
    return
  }

  // Show loading state
  chatStore.addSystemMessage('Loading MoMenu Payment skills...')
  useAgentStore.getState().setStatus('thinking')

  // Fetch skills from GitHub (fire-and-forget — not persisted)
  let skillsContent: string
  try {
    skillsContent = await fetchAllSkills()
  } catch (err) {
    logger.error('payments', 'Failed to fetch skills:', err)
    useAgentStore.getState().setStatus('idle')
    chatStore.addSystemMessage(
      'Failed to load payment skills. Check your internet connection and try again.'
    )
    return
  }

  if (!skillsContent) {
    useAgentStore.getState().setStatus('idle')
    chatStore.addSystemMessage(
      'Could not fetch any payment skills from the repository.'
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

  // Run the agent with skills injected as context (fire-and-forget)
  await runAgentWithCallbacks(prompt, {
    addUserMessage: true,
    userMessageText: `/payments ${args}`,
    useConversationHistory: true,
  })
}
