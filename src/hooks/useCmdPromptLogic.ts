import { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useProjectStore } from '../stores/projectStore'
import { useAuthStore } from '../stores/authStore'
import { slashCommandRegistry, type SlashCommand } from '../services/agent/slashCommandRegistry'
import { CMD_MODE_COMMANDS } from '../services/agent/cmdModeCommands'
import { runAgentWithCallbacks } from '../services/agent/agentRunner'
import {
  enqueue,
  remove,
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../services/agent/messageQueue'
import { useQueueProcessor } from './useQueueProcessor'
import { useAttachments } from './useAttachments'
import QuickOpenService, { type QuickOpenItem } from '../services/quickOpenService'
import { extractAndResolveMentions } from '../services/attachmentService'
import { findMentionAtCursor, findMentionTokenEnd } from '../utils/mentionParser'
import type { ContentBlock, PromptValue, QueuedCommand } from '../types/messageQueueTypes'

const MENTION_MENU_LIMIT = 50

/**
 * CMD-mode prompt logic — slash commands, message queue, @mention support.
 */
const NO_ARG_COMMANDS = new Set(['/exit', '/new', '/clear', '/init', '/payments'])

// Control commands that must run immediately even while the agent is streaming.
// They each stop the agent internally (stopAgent()) before doing their work, so
// queueing them would defeat their purpose — /exit would wait for the very task
// it's supposed to cancel.
const CONTROL_COMMANDS_BYPASS_QUEUE = new Set(['/exit', '/new', '/clear'])

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
  const [mentionQuery, setMentionQuery] = useState('')

  // Subscribe to QuickOpen index state so the menu updates as soon as indexing finishes
  const quickOpenVersion = useSyncExternalStore(
    (listener) => QuickOpenService.getInstance().subscribe(listener),
    () => QuickOpenService.getInstance().getVersion(),
  )
  const quickOpenBuilding = QuickOpenService.getInstance().isBuilding()

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)

  const isStreaming = useChatStore(s => s.isStreaming)
  const currentProject = useProjectStore(s => s.currentProject)
  const cmdModePath = useProjectStore(s => s.cmdModeProjectPath)
  const projectPath = currentProject?.path || cmdModePath || ''

  const queuedCommands = useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)

  // Attachment handling — uses local state (CMD mode manages its own lifecycle)
  const {
    attachments: draftAttachments,
    removeAttachment,
    clearAttachments,
    supportsImages,
    showImageWarning,
    billingPlan,
    handlePaste,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    isDragging,
    handleAttachFiles,
  } = useAttachments({ localState: true, textareaRef })

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

  const executePrompt = useCallback(async (promptValue: PromptValue): Promise<void> => {
    const path = currentProject?.path || useProjectStore.getState().cmdModeProjectPath || ''

    // Extract text for slash/shell dispatch (attachments only go through agent path)
    const textPrompt = typeof promptValue === 'string'
      ? promptValue
      : promptValue.filter(b => b.type === 'text').map(b => b.text).join(' ')

    // ── ! prefix: run shell command directly, output injected into conversation ──
    if (textPrompt.startsWith('! ')) {
      const command = textPrompt.slice(2).trim()
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
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        useChatStore.getState().addSystemMessage(`$ ${command}: ${msg}`, 'error')
      }
      return
    }

    // ── Slash command dispatch ──
    const command = findCommand(textPrompt, allCommands)
    if (command) {
      if (!command.enabled) {
        useChatStore.getState().addSystemMessage(`Command ${command.name} is not yet available.`, 'warn')
        return
      }
      await command.execute(extractArgs(textPrompt), path)
      return
    }

    // ── Agent prompt ──
    const { isAuthenticated } = useAuthStore.getState()
    if (!isAuthenticated) {
      useChatStore.getState().addSystemMessage('You must be signed in to use the agent.', 'error')
      return
    }

    // Resolve @mentions before sending — appends <mentioned_files> context to the prompt
    const mentionContext = path ? await extractAndResolveMentions(textPrompt, path) : ''
    const fullPrompt = mentionContext ? `${textPrompt}\n\n${mentionContext}` : textPrompt

    // Extract attachments from blocks for the user message display
    const attachments = typeof promptValue === 'string'
      ? undefined
      : promptValue.filter(b => b.type === 'attachment').map(b => b.attachment)

    await runAgentWithCallbacks(fullPrompt, {
      addUserMessage: true,
      userMessageText: textPrompt,
      userMessageAttachments: attachments,
      userMessageBlocks: typeof promptValue === 'string' ? undefined : promptValue,
      useConversationHistory: true,
      cmdOnlyMode: true,
    })
  }, [allCommands, findCommand, extractArgs, currentProject])

  // ─── Queue processor ───

  const executeQueuedInput = useCallback(async (commands: QueuedCommand[]): Promise<void> => {
    for (const cmd of commands) {
      // Pass the full PromptValue through — executePrompt handles both
      // string and ContentBlock[] (extracting text for slash/shell dispatch,
      // passing attachments to the agent boundary).
      await executePrompt(cmd.value)
    }
  }, [executePrompt])

  useQueueProcessor({ executeQueuedInput })

  // ─── @mention selection ───

  const handleMentionSelect = useCallback((item: QuickOpenItem) => {
    const textarea = textareaRef.current
    const start = mentionStartRef.current
    if (start < 0 || !textarea) return

    const val = textarea.value
    // Replace the WHOLE mention token — not just up to the cursor — so a user
    // who was editing in the middle (e.g. "@App|Tsx", selects "App.tsx")
    // doesn't end up with trailing garbage ("@App.tsx Tsx").
    const tokenEnd = findMentionTokenEnd(val, start + 1)
    const before = val.slice(0, start)
    const after = val.slice(tokenEnd)

    // Derive a relative path. item.path is absolute from the index; strip the
    // project root with correct separator handling for Win / Posix.
    const normRoot = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const normItem = item.path.replace(/\\/g, '/')
    const relativePath = normItem.startsWith(normRoot + '/')
      ? normItem.slice(normRoot.length + 1)
      : normItem

    const suffix = item.isDirectory ? '/' : ''
    const insertion = `@${relativePath}${suffix} `
    const newValue = before + insertion + after
    const newCursor = before.length + insertion.length

    // Nudge recency so this entry floats to the top of the next `@` list.
    QuickOpenService.getInstance().markUsed(item.path)

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

    // @mention detection — unicode-safe, shared with chat prompt & resolver.
    const cursorPos = textareaRef.current?.selectionStart ?? value.length
    const mention = findMentionAtCursor(value, cursorPos)

    if (!mention) {
      setShowMentionMenu(false)
      setMentionQuery('')
      mentionStartRef.current = -1
      return
    }

    const { atIndex, query } = mention
    const svc = QuickOpenService.getInstance()
    const results = query.length === 0
      ? svc.list(MENTION_MENU_LIMIT, true)
      : svc.search(query, MENTION_MENU_LIMIT, true)

    // Always open the menu when an @-mention is in progress — empty results
    // are rendered as an "indexing…" / "no matches" state inside the menu.
    setFilteredMentions(results)
    setShowMentionMenu(true)
    setSelectedMentionIndex(0)
    setMentionQuery(query)
    mentionStartRef.current = atIndex
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
    const hasAttachments = draftAttachments.length > 0
    if (!prompt && !hasAttachments) return

    setInput('')
    setShowCommandMenu(false)
    setShowMentionMenu(false)

    historyRef.current = [prompt, ...historyRef.current.filter(h => h !== prompt)].slice(0, 100)
    historyIndexRef.current = -1

    // Build value: plain string or ContentBlock[] with attachments
    let value: PromptValue
    if (hasAttachments) {
      const blocks: ContentBlock[] = []
      if (prompt.length > 0) blocks.push({ type: 'text', text: prompt })
      for (const att of draftAttachments) {
        blocks.push({ type: 'attachment', attachment: att })
      }
      value = blocks
      clearAttachments()
    } else {
      value = prompt
    }

    // Control commands (/exit, /new, /clear) bypass the queue — they cancel
    // the running agent as part of their work, so queueing would make them
    // wait for the very thing they mean to stop.
    const textForDispatch = typeof value === 'string'
      ? value
      : value.filter(b => b.type === 'text').map(b => b.text).join(' ')
    const firstToken = textForDispatch.trim().split(/\s+/)[0] || ''
    const isBypassCommand = CONTROL_COMMANDS_BYPASS_QUEUE.has(firstToken)

    if (isStreaming && !isBypassCommand) {
      enqueue({ value, mode: 'prompt', priority: 'next', uuid: crypto.randomUUID() })
      return
    }

    await executePrompt(value)
  }, [input, isStreaming, executePrompt, draftAttachments, clearAttachments])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // @mention menu navigation — takes priority when open
      if (showMentionMenu) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setShowMentionMenu(false)
          return
        }
        if (filteredMentions.length > 0) {
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

      // History navigation (when menus are closed).
      // Terminal UX: ArrowUp only navigates history when the caret is at the
      // very start of the input (or already browsing history). If the user
      // is mid-edit, let the textarea handle ArrowUp normally (move cursor
      // up a line in multi-line input, or to the start on single-line).
      if (!showCommandMenu && !showMentionMenu) {
        const ta = textareaRef.current
        const caret = ta?.selectionStart ?? 0
        const selLen = ta ? ta.selectionEnd - ta.selectionStart : 0
        const atStart = caret === 0 && selLen === 0
        const browsingHistory = historyIndexRef.current >= 0

        if (e.key === 'ArrowUp') {
          // Priority 1: Edit queued message if one exists and input is empty
          if (input.length === 0 && queuedCommands.length > 0) {
            e.preventDefault()
            const lastQueued = queuedCommands[queuedCommands.length - 1]!
            const val = typeof lastQueued.value === 'string'
              ? lastQueued.value
              : lastQueued.value.map(b => (b.type === 'text' ? b.text : '')).join(' ')

            remove([lastQueued as QueuedCommand])
            setInput(val)
            return
          }

          // Priority 2: Standard history navigation — only if caret is at
          // the start and input is empty, OR the user is already cycling
          // through history. Otherwise let the textarea handle ArrowUp.
          if (!browsingHistory && (input.length > 0 || !atStart)) {
            return
          }
          const history = historyRef.current
          if (history.length === 0) return
          e.preventDefault()
          const newIndex = Math.min(historyIndexRef.current + 1, history.length - 1)
          historyIndexRef.current = newIndex
          setInput(history[newIndex])
          return
        }
        if (e.key === 'ArrowDown') {
          // Only hijack ArrowDown while actively browsing history — otherwise
          // it should move the caret normally within the textarea.
          if (!browsingHistory) return
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

  // Re-run @mention search when the QuickOpen index finishes building (or
  // when live watcher events mutate the index).
  useEffect(() => {
    if (!showMentionMenu) return
    const svc = QuickOpenService.getInstance()
    const results = mentionQuery.length === 0
      ? svc.list(MENTION_MENU_LIMIT, true)
      : svc.search(mentionQuery, MENTION_MENU_LIMIT, true)
    setFilteredMentions(results)
    setSelectedMentionIndex(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickOpenVersion, showMentionMenu, mentionQuery])

  const canSend = input.trim().length > 0 || draftAttachments.length > 0

  return {
    input,
    setInput,
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    showMentionMenu,
    filteredMentions,
    selectedMentionIndex,
    mentionQuery,
    quickOpenBuilding,
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
    // Attachments
    draftAttachments,
    removeAttachment,
    clearAttachments,
    supportsImages,
    showImageWarning,
    billingPlan,
    handlePaste,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    isDragging,
    handleAttachFiles,
  }
}
