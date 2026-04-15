import { useState, useCallback, useRef, useEffect } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useProjectStore } from '../stores/projectStore'
import { useAuthStore } from '../stores/authStore'
import { slashCommandRegistry, type SlashCommand } from '../services/agent/slashCommandRegistry'
import { runAgentWithCallbacks } from '../services/agent/agentRunner'

/**
 * Shared prompt input logic — used by both PromptInput (chat) and
 * CmdModePromptInput (terminal). Only rendering differs.
 */
export function usePromptLogic() {
  const [input, setInput] = useState('')
  const [showCommandMenu, setShowCommandMenu] = useState(false)
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([])
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isStreaming = useChatStore(s => s.isStreaming)
  const currentProject = useProjectStore(s => s.currentProject)

  // Cleanup blur timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    }
  }, [])

  const handleInputChange = useCallback((value: string) => {
    setInput(value)

    // Only show command menu when typing the command itself (no space yet = no args)
    const firstWord = value.split(' ')[0]
    if (value.startsWith('/') && !value.includes(' ')) {
      const commands = slashCommandRegistry.filterCommands(firstWord)
      setFilteredCommands(commands)
      setShowCommandMenu(commands.length > 0)
      setSelectedCommandIndex(0)
    } else {
      setShowCommandMenu(false)
    }
  }, [])

  const handleCommandSelect = useCallback((command: SlashCommand) => {
    setInput(command.name + ' ')
    setShowCommandMenu(false)
    textareaRef.current?.focus()
  }, [])

  const handleSend = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || isStreaming) return

    const { isAuthenticated } = useAuthStore.getState()
    if (!isAuthenticated) {
      useChatStore.getState().addSystemMessage('You must be signed in to use the agent.')
      return
    }

    setInput('')
    setShowCommandMenu(false)

    // Check if it's a slash command
    if (slashCommandRegistry.isSlashCommand(prompt)) {
      const command = slashCommandRegistry.getCommand(prompt)
      if (!command) return

      if (!command.enabled) {
        useChatStore.getState().addSystemMessage(`Command ${command.name} is not yet available.`)
        return
      }

      const projectPath = currentProject?.path
      if (!projectPath) {
        useChatStore.getState().addSystemMessage('No project open. Open a project first.')
        return
      }

      const args = slashCommandRegistry.getArgs(prompt)
      await command.execute(args, projectPath)
      return
    }

    // Normal prompt — use shared agent runner
    await runAgentWithCallbacks(prompt, {
      addUserMessage: true,
      useConversationHistory: true,
    })
  }, [input, isStreaming, currentProject])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Handle command menu navigation
      if (showCommandMenu && filteredCommands.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedCommandIndex(prev =>
            prev <= 0 ? filteredCommands.length - 1 : prev - 1
          )
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedCommandIndex(prev =>
            prev >= filteredCommands.length - 1 ? 0 : prev + 1
          )
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
          e.preventDefault()
          const selected = filteredCommands[selectedCommandIndex]
          if (selected) {
            handleCommandSelect(selected)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowCommandMenu(false)
          return
        }
      }

      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend, showCommandMenu, filteredCommands, selectedCommandIndex, handleCommandSelect]
  )

  const handleBlur = useCallback(() => {
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    blurTimeoutRef.current = setTimeout(() => setShowCommandMenu(false), 150)
  }, [])

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const maxHeight = 6 * 24
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  }, [input])

  const canSend = input.trim().length > 0 && !isStreaming

  return {
    input,
    setInput,
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    textareaRef,
    isStreaming,
    canSend,
    handleInputChange,
    handleCommandSelect,
    handleSend,
    handleKeyDown,
    handleBlur,
  }
}
