import { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useProjectStore } from '../stores/projectStore'
import { useAuthStore } from '../stores/authStore'
import { slashCommandRegistry, type SlashCommand } from '../services/agent/slashCommandRegistry'
import { CMD_MODE_COMMANDS } from '../services/agent/cmdModeCommands'
import { runAgentWithCallbacks } from '../services/agent/agentRunner'
import {
  enqueue,
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../services/agent/messageQueue'
import { useQueueProcessor } from './useQueueProcessor'
import QuickOpenService, { type QuickOpenItem } from '../services/quickOpenService'
import { extractAndResolveMentions } from '../services/attachmentService'
import type { QueuedCommand } from '../types/messageQueueTypes'

/**
 * CMD-mode prompt logic — slash commands, message queue, @mention support.
 */
const NO_ARG_COMMANDS = new Set(['/exit', '/new', '/clear', '/init', '/payments'])

export function useCmdPromptLogic() {
  const [input, setInput] = useState('')

  // Slash command menu
  const [showCommandMenu, setShowCommandMenu] = useState(false)
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([])
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)

  // @mention menu
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  const [filteredMentions, setFilteredMentions] = useState<QuickOpenItem[]>([])
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const mentionStartRef = useRef(-1)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)

  const isStreaming = useChatStore(s => s.isStreaming)
  const currentProject = useProjectStore(s => s.currentProject)
  const cmdModePath = useProjectStore(s => s.cmdModeProjectPath)
  const projectPath = currentProject?.path || cmdModePath || ''

  const queuedCommands = useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)

  const allCommands = useMemo(() => {
    const globalCmds = slashCommandRegistry.listCommands()
    return [...CMD_MODE_COMMANDS, ...globalCmds]
  }, [])

  // Build QuickOpen index for @mention search
  useEffect(() => {
    if (!projectPath) return
    QuickOpenService.getInstance().initialize(projectPath).catch(() => {})
  }, [projectPath])

  // Cleanup blur timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    }
  }, [])

  // ─── Helpers ───

  const filterCommands = useCallback((prefix: string, cmds: SlashCommand[]): SlashCommand[] => {
    return cmds.filter(cmd => cmd.name.startsWith(prefix.toLowerCase()))
  }, [])

  const findCommand = useCallback((input: string, cmds: SlashCommand[]): SlashCommand | null => {
    const cmd = input.trim().split(' ')[0]
    return cmds.find(c => c.name === cmd) || null
  }, [])

  const extractArgs = useCallback((input: string): string => {
    const parts = input.trim().split(' ')
    return parts.slice(1).join(' ')
  }, [])

  const executePrompt = useCallback(async (prompt: string): Promise<void> => {
    const path = currentProject?.path || useProjectStore.getState().cmdModeProjectPath || ''

    // ── ! prefix: run shell command directly, output injected into conversation ──
    if (prompt.startsWith('! ')) {
      const command = prompt.slice(2).trim()
      if (!command) return
      try {
        const { invoke } = await import('@tauri-apps/api/core')

        // Resolve CWD: use project path if open, otherwise fall back to home directory
        // (Tauri's default CWD is the app bundle dir — not useful for the user)
        let cwd: string | undefined = path || undefined
        if (!cwd) {
          try { cwd = await invoke<string>('get_home_directory') }
          catch { /* leave undefined */ }
        }

        const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>('execute_command', {
          command,
          cwd,
          timeoutSecs: 30,
        })
        const output = [result.stdout, result.stderr].filter(s => s.trim()).join('\n') || '(no output)'
        const msgContent = `$ ${command}\n\`\`\`\n${output}\n\`\`\``
        useChatStore.getState().addUserMessage(msgContent)
        // DO NOT call updateConversationHistory here — rebuildConversationHistory
        // runs after each agent response and reconstructs from session.messages,
        // which already includes this message via addUserMessage. A manual update
        // here would create consecutive user turns that the Anthropic API rejects.
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        useChatStore.getState().addSystemMessage(`$ ${command}: ${msg}`, 'error')
      }
      return
    }

    // ── Slash command dispatch ──
    const command = findCommand(prompt, allCommands)
    if (command) {
      if (!command.enabled) {
        useChatStore.getState().addSystemMessage(`Command ${command.name} is not yet available.`, 'warn')
        return
      }
      await command.execute(extractArgs(prompt), path)
      return
    }

    // ── Agent prompt ──
    const { isAuthenticated } = useAuthStore.getState()
    if (!isAuthenticated) {
      useChatStore.getState().addSystemMessage('You must be signed in to use the agent.', 'error')
      return
    }

    // Resolve @mentions before sending — appends <mentioned_files> context to the prompt
    const mentionContext = path ? await extractAndResolveMentions(prompt, path) : ''
    const fullPrompt = mentionContext ? `${prompt}\n\n${mentionContext}` : prompt

    await runAgentWithCallbacks(fullPrompt, {
      addUserMessage: true,
      userMessageText: prompt, // show the original prompt in the UI, not the expanded version
      useConversationHistory: true,
      cmdOnlyMode: true, // CMD Mode always uses CLI behavior regardless of project state
    })
  }, [allCommands, findCommand, extractArgs, currentProject])

  // ─── Queue processor ───

  const executeQueuedInput = useCallback(async (commands: QueuedCommand[]): Promise<void> => {
    for (const cmd of commands) {
      const prompt = typeof cmd.value === 'string'
        ? cmd.value
        : cmd.value.map(b => (b.type === 'text' ? b.text : '')).join(' ')
      await executePrompt(prompt.trim())
    }
  }, [executePrompt])

  useQueueProcessor({ executeQueuedInput })

  // ─── @mention selection ───

  const handleMentionSelect = useCallback((item: QuickOpenItem) => {
    const textarea = textareaRef.current
    const start = mentionStartRef.current
    if (start < 0 || !textarea) return

    const val = textarea.value
    const cursorPos = textarea.selectionStart ?? val.length
    const before = val.slice(0, start)
    const after = val.slice(cursorPos)
    const relativePath = item.path.startsWith(projectPath)
      ? item.path.slice(projectPath.length + 1)
      : item.path
    const insertion = `@${relativePath} `
    const newValue = before + insertion + after
    const newCursor = before.length + insertion.length

    setInput(newValue)
    mentionStartRef.current = -1
    setShowMentionMenu(false)

    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(newCursor, newCursor)
    })
  }, [projectPath])

  // ─── Input handlers ───

  const handleInputChange = useCallback((value: string) => {
    setInput(value)

    // Slash command menu
    const firstWord = value.split(' ')[0]
    if (value.startsWith('/') && !value.includes(' ')) {
      const commands = filterCommands(firstWord, allCommands)
      setFilteredCommands(commands)
      setShowCommandMenu(commands.length > 0)
      setSelectedCommandIndex(0)
      setShowMentionMenu(false)
      return
    }
    setShowCommandMenu(false)

    // @mention detection — synchronous, reads cursor position directly from the DOM
    // (selectionStart is valid during onChange before React re-renders)
    const cursorPos = textareaRef.current?.selectionStart ?? value.length

    let atIndex = -1
    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = value[i]
      if (ch === '@') {
        if (i === 0 || /\s/.test(value[i - 1])) atIndex = i
        break
      }
      if (/\s/.test(ch)) break
    }

    if (atIndex === -1) {
      setShowMentionMenu(false)
      return
    }

    const query = value.slice(atIndex + 1, cursorPos)
    const svc = QuickOpenService.getInstance()
    const results = query.length === 0 ? svc.list(20) : svc.search(query, 20)

    if (results.length > 0) {
      setFilteredMentions(results)
      setShowMentionMenu(true)
      setSelectedMentionIndex(0)
      mentionStartRef.current = atIndex
    } else {
      setShowMentionMenu(false)
    }
  }, [allCommands, filterCommands])

  const handleCommandSelect = useCallback((command: SlashCommand) => {
    setShowCommandMenu(false)
    if (NO_ARG_COMMANDS.has(command.name)) {
      setInput('')
      executePrompt(command.name)
    } else {
      setInput(command.name + ' ')
      textareaRef.current?.focus()
    }
  }, [executePrompt])

  const handleSend = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt) return

    setInput('')
    setShowCommandMenu(false)
    setShowMentionMenu(false)

    historyRef.current = [prompt, ...historyRef.current.filter(h => h !== prompt)].slice(0, 100)
    historyIndexRef.current = -1

    if (isStreaming) {
      enqueue({ value: prompt, mode: 'prompt', priority: 'next', uuid: crypto.randomUUID() })
      return
    }

    await executePrompt(prompt)
  }, [input, isStreaming, executePrompt])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // @mention menu navigation — takes priority when open
      if (showMentionMenu && filteredMentions.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedMentionIndex(prev => (prev <= 0 ? filteredMentions.length - 1 : prev - 1))
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedMentionIndex(prev => (prev >= filteredMentions.length - 1 ? 0 : prev + 1))
          return
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault()
          handleMentionSelect(filteredMentions[selectedMentionIndex])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowMentionMenu(false)
          return
        }
      }

      // Slash command menu navigation
      if (showCommandMenu && filteredCommands.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedCommandIndex(prev => (prev <= 0 ? filteredCommands.length - 1 : prev - 1))
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedCommandIndex(prev => (prev >= filteredCommands.length - 1 ? 0 : prev + 1))
          return
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault()
          const selected = filteredCommands[selectedCommandIndex]
          if (selected?.enabled) handleCommandSelect(selected)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowCommandMenu(false)
          return
        }
      }

      // History navigation (when menus are closed)
      if (!showCommandMenu && !showMentionMenu) {
        if (e.key === 'ArrowUp') {
          const history = historyRef.current
          if (history.length === 0) return
          e.preventDefault()
          const newIndex = Math.min(historyIndexRef.current + 1, history.length - 1)
          historyIndexRef.current = newIndex
          setInput(history[newIndex])
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (historyIndexRef.current <= 0) {
            historyIndexRef.current = -1
            setInput('')
            return
          }
          historyIndexRef.current--
          setInput(historyRef.current[historyIndexRef.current])
          return
        }
      }

      // Enter = send, Shift+Enter = newline
      if (e.key === 'Enter') {
        if (e.shiftKey) return
        e.preventDefault()
        handleSend()
      }
    },
    [
      handleSend,
      showCommandMenu, filteredCommands, selectedCommandIndex, handleCommandSelect,
      showMentionMenu, filteredMentions, selectedMentionIndex, handleMentionSelect,
    ]
  )

  const handleFocus = useCallback(() => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current)
      blurTimeoutRef.current = null
    }
  }, [])

  const handleBlur = useCallback(() => {
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    blurTimeoutRef.current = setTimeout(() => {
      setShowCommandMenu(false)
      setShowMentionMenu(false)
    }, 150)
  }, [])

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const maxHeight = 6 * 24
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  }, [input])

  const canSend = input.trim().length > 0

  return {
    input,
    setInput,
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    showMentionMenu,
    filteredMentions,
    selectedMentionIndex,
    textareaRef,
    isStreaming,
    canSend,
    queuedCommands,
    projectPath,
    handleInputChange,
    handleCommandSelect,
    handleMentionSelect,
    handleSend,
    handleKeyDown,
    handleFocus,
    handleBlur,
  }
}
