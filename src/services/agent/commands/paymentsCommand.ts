import { useChatStore } from '../../../stores/chatStore'
import { runAgentWithCallbacks } from '../agentRunner'
import { logger } from '../../../utils/logger'

const SKILLS_BASE = 'https://raw.githubusercontent.com/ithustle/momenu-skills/main/skills'

const SKILL_FILES = [
  { name: 'mom-factura-payments', files: ['SKILL.md', 'references/STATUS-POLLING.md'] },
  { name: 'mom-factura-webhooks', files: ['SKILL.md'] },
  { name: 'mom-factura-testing', files: ['SKILL.md'] },
]

async function fetchSkillContent(skillName: string, file: string): Promise<{ label: string; content: string } | null> {
  try {
    const url = `${SKILLS_BASE}/${skillName}/${file}`
    const res = await fetch(url)
    if (!res.ok) return null
    const content = await res.text()
    const label = file === 'SKILL.md' ? skillName : `${skillName}/${file}`
    return { label, content }
  } catch {
    return null
  }
}

async function fetchAllSkills(): Promise<string> {
  // Fetch all skill files in parallel
  const fetches = SKILL_FILES.flatMap(skill =>
    skill.files.map(file => fetchSkillContent(skill.name, file))
  )
  const results = await Promise.all(fetches)

  const parts: string[] = []
  for (const result of results) {
    if (result) {
      // Sanitize: escape XML-like tags to prevent prompt injection from remote content
      const sanitized = result.content.replace(/</g, '＜').replace(/>/g, '＞')
      parts.push(`<skill name="${result.label}">\n${sanitized}\n</skill>`)
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

  // Fetch skills from GitHub (fire-and-forget — not persisted)
  let skillsContent: string
  try {
    skillsContent = await fetchAllSkills()
  } catch (err) {
    logger.error('payments', 'Failed to fetch skills:', err)
    chatStore.addSystemMessage(
      'Failed to load payment skills. Check your internet connection and try again.'
    )
    return
  }

  if (!skillsContent) {
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

  // Run the agent with skills injected as context (fire-and-forget).
  // Status management is handled entirely by runAgentWithCallbacks — don't set it manually.
  await runAgentWithCallbacks(prompt, {
    addUserMessage: true,
    userMessageText: `/payments ${args}`,
    useConversationHistory: true,
  })
}
