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
  // True when the menu is showing argument suggestions (after `<cmd> `) vs.
  // command-name suggestions. Drives the footer hint that tells the user
  // they can keep typing free-form instructions after picking args.
  const [isArgMode, setIsArgMode] = useState(false)
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

    // Mode 1: typing the command name itself (no space) → suggest commands
    if (value.startsWith('/') && !value.includes(' ')) {
      const firstWord = value.split(' ')[0]
      const commands = slashCommandRegistry.filterCommands(firstWord)
      setFilteredCommands(commands)
      setShowCommandMenu(commands.length > 0)
      setSelectedCommandIndex(0)
      setIsArgMode(false)
      return
    }

    // Mode 2: typed `<known-cmd> [partial]` → suggest argument values. Each
    // selection appends the value with a trailing space so the menu can
    // re-trigger for the next arg in a chain.
    const argResult = slashCommandRegistry.getArgSuggestions(value)
    if (argResult) {
      const argItems: SlashCommand[] = argResult.suggestions.map(arg => ({
        name: arg.value,
        description: arg.description,
        enabled: true,
        execute: async () => {}, // pick handled by handleCommandSelect
      }))
      setFilteredCommands(argItems)
      setShowCommandMenu(true)
      setSelectedCommandIndex(0)
      setIsArgMode(true)
      return
    }

    setShowCommandMenu(false)
    setIsArgMode(false)
  }, [])

  const handleCommandSelect = useCallback((command: SlashCommand) => {
    setInput(prev => {
      // Arg mode: replace the trailing partial word with the picked value
      // (preserving the command name and any previously-committed args).
      // Command mode: replace the whole buffer with `<cmd> ` so the user
      // can start typing args immediately.
      let nextValue: string
      if (prev.includes(' ')) {
        const lastSpaceIdx = prev.lastIndexOf(' ')
        const prefix = prev.slice(0, lastSpaceIdx + 1)
        nextValue = prefix + command.name + ' '
      } else {
        nextValue = command.name + ' '
      }
      // Re-evaluate menu state for the new value so chained arg picks
      // (`email-password` then `google`) auto-open the next round of
      // suggestions without the user having to backspace and retype.
      const argResult = slashCommandRegistry.getArgSuggestions(nextValue)
      if (argResult) {
        const argItems: SlashCommand[] = argResult.suggestions.map(arg => ({
          name: arg.value,
          description: arg.description,
          enabled: true,
          execute: async () => {},
        }))
        setFilteredCommands(argItems)
        setShowCommandMenu(true)
        setSelectedCommandIndex(0)
        setIsArgMode(true)
      } else {
        setShowCommandMenu(false)
        setIsArgMode(false)
      }
      return nextValue
    })
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
    isArgMode,
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
