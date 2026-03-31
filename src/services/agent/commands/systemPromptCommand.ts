import { useChatStore } from '../../../stores/chatStore'
import { useProjectStore } from '../../../stores/projectStore'
import ContextBuilder from '../contextBuilder'

export async function executeSystemPrompt(_args: string, projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()
  const currentProject = useProjectStore.getState().currentProject
  const projectType = currentProject?.projectType || 'unknown'

  chatStore.addSystemMessage('Building current system prompt...')

  try {
    const contextBuilder = ContextBuilder.getInstance()
    const systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, projectType)

    chatStore.addSystemMessage(
      '📋 **System Prompt**\n\n```\n' + systemPrompt + '\n```'
    )
  } catch (err) {
    chatStore.addSystemMessage(
      'Failed to build system prompt: ' + (err instanceof Error ? err.message : String(err))
    )
  }
}
