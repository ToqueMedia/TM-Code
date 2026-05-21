import { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useProjectStore } from '../stores/projectStore'
import { useAuthStore } from '../stores/authStore'
import { useTerminalPanelStore } from '../stores/terminalPanelStore'
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
import { preprocessHashtags } from '../services/agent/hashtagRegistry'
import { useHashtagMenu } from '../components/prompt/useHashtagMenu'
import { runAuthFlow, runDesignFlow } from '../services/agent/commands/authCommand'
import { t } from '../i18n/useTranslation'
import {
  loadPromptHistory,
  savePromptHistory,
  mergePromptHistory,
  onHistoryReset,
  MAX_PROMPT_HISTORY,
} from '../services/cmdPromptHistory'
import type { ContentBlock, PromptValue, QueuedCommand } from '../types/messageQueueTypes'

const MENTION_MENU_LIMIT = 50

/**
 * CMD-mode prompt logic — slash commands, message queue, @mention support.
 */
const NO_ARG_COMMANDS = new Set(['/exit', '/new', '/clear', '/init', '/payments', '/terminal'])

// Control commands that must run immediately even while the agent is streaming.
// They each stop the agent internally (stopAgent()) before doing their work, so
// queueing them would defeat their purpose — /exit would wait for the very task
// it's supposed to cancel.
const CONTROL_COMMANDS_BYPASS_QUEUE = new Set(['/exit', '/new', '/clear', '/terminal'])

function isTerminalToggleCommand(input: string): boolean {
  return input.trim() === '/terminal'
}

export function useCmdPromptLogic() {
  const [input, setInput] = useState('')

  // Slash command menu
  const [showCommandMenu, setShowCommandMenu] = useState(false)
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([])
  // True when the menu is in arg-suggestion mode (after `<cmd> `). Drives
  // the footer hint informing the user free-form text follows the args.
  const [isArgMode, setIsArgMode] = useState(false)
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

  // #hashtag menu — closed-vocabulary skill triggers (e.g. #auth-google).
  // State + handlers live in the shared hook (also used by chat-mode).
  // Declared after textareaRef because the hook captures the ref at call time.
  const hashtagMenu = useHashtagMenu({
    textareaRef,
    setInputValue: setInput,
    getInputValue: () => textareaRef.current?.value ?? '',
  })

  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Pending shell command from `! ` prefix — stored in ref, consumed by effect
  // that waits for PTY session readiness instead of polling.
  const pendingShellCmdRef = useRef<string | null>(null)
  // History is kept in-memory for instant ArrowUp/Down; IDB is only touched
  // on mount (load) and send (write). See src/services/cmdPromptHistory.ts.
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  // Track which project the loaded history belongs to — when the user switches
  // CMD-mode projects (same hook instance on remount is typical, but guard
  // anyway), we reload to avoid mixing histories.
  const historyLoadedForRef = useRef<string | null>(null)

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

  // Consume pending `! ` shell command once PTY session is ready.
  // Uses Zustand subscription instead of polling for instant reaction.
  useEffect(() => {
    const unsubscribe = useTerminalPanelStore.subscribe((state) => {
      const cmd = pendingShellCmdRef.current
      if (cmd && state.ptySessionId) {
        pendingShellCmdRef.current = null
        state.writeToPty(cmd + '\r')
      }
    })
    return unsubscribe
  }, [])

  // Load persisted prompt history from IDB once per project — populates the
  // in-memory ref used for ArrowUp/Down navigation. Non-blocking: the UI
  // renders immediately and ArrowUp on an empty history is a no-op anyway.
  //
  // Race-safe via `mergePromptHistory`: if the user sent a prompt before the
  // IDB read finished, those fresh in-memory entries stay at index 0 and the
  // older persisted entries are appended behind them. The naive "replace when
  // empty" check from the first iteration lost disk history whenever a send
  // raced ahead of the load — this merge preserves both sides.
  useEffect(() => {
    if (!projectPath) return
    if (historyLoadedForRef.current === projectPath) return
    let cancelled = false
    loadPromptHistory(projectPath).then(persisted => {
      if (cancelled) return
      historyRef.current = mergePromptHistory(historyRef.current, persisted)
      historyLoadedForRef.current = projectPath
    }).catch(() => { /* IDB unavailable — stay with in-memory */ })
    return () => { cancelled = true }
  }, [projectPath])

  // Listen for externally-triggered resets (e.g. the /history-clear command)
  // so the in-memory ref drops in lock-step with the IDB delete. Without this,
  // ArrowUp would keep resurrecting cleared prompts until the hook remounts.
  useEffect(() => {
    return onHistoryReset((path) => {
      if (path === projectPath) {
        historyRef.current = []
        historyIndexRef.current = -1
      }
    })
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

    // ── ! prefix: run shell command in the terminal panel ──
    if (textPrompt.startsWith('! ')) {
      const command = textPrompt.slice(2).trim()
      if (!command) return
      // Open terminal panel if not already open.
      const tpStore = useTerminalPanelStore.getState()
      if (!tpStore.isOpen) {
        tpStore.toggle()
      }
      // If PTY session is already ready, write immediately.
      // Otherwise, store in ref — the useEffect subscription will consume it
      // as soon as ptySessionId becomes available.
      if (tpStore.ptySessionId) {
        tpStore.writeToPty(command + '\r')
      } else {
        pendingShellCmdRef.current = command
      }
      return
    }

    // ── /terminal: local CMD-mode control, not an agent slash command ──
    //
    // Keep this as an explicit fast path instead of relying only on
    // CMD_MODE_COMMANDS lookup. The terminal panel is UI state owned by CMD mode,
    // so it should toggle even if the global slash registry/menu changes.
    if (isTerminalToggleCommand(textPrompt)) {
      useTerminalPanelStore.getState().toggle()
      return
    }

    // ── Slash command dispatch ──
    const command = findCommand(textPrompt, allCommands)
    if (command) {
      if (!command.enabled) {
        useChatStore.getState().addSystemMessage(`Command ${command.name} is not yet available.`, 'warn')
        return
      }
      // Smart router for /payments — same parity as chat-mode usePromptBar.
      // The hashtag/slash flows are first-time scaffolding; subsequent fixes
      // go through verbal requests so the agent's appliedScaffolding system-
      // prompt section routes to fix-mode rather than re-running fetches.
      if (command.name === '/payments' && path) {
        const { guardScaffoldReapply } = await import('../components/prompt/scaffoldReapplyGuard')
        const { blocked } = await guardScaffoldReapply(
          path,
          ['payments.momenu'],
          () => buildCmdPaymentsReapplyMessage(),
          () => { /* cmd-mode has no draftInput state to clear */ },
        )
        if (blocked) return
      }
      // 'terminal' = free-form surface. /plan branches on this to drop
      // the platform-deploy invariants (firebase-admin / Dockerfile /
      // APP_ID fallback) — the developer here is running outside the
      // Publish flow and may target any backend / database / hosting.
      // The architect keeps its structural rigor (full PLAN.md template,
      // trade-offs, completion rule) but is free to recommend any stack.
      await command.execute(extractArgs(textPrompt), path, 'terminal')
      return
    }

    // ── Hashtag-driven flows (e.g. #auth-google, #design) — load the
    // relevant skills inline and route to a specialised flow. Free-form
    // `#tags` not in the registry pass through untouched.
    const pre = preprocessHashtags(textPrompt)
    if (pre.authProviders.length > 0 || pre.hasDesign) {
      // Skill flows inherently write files into a project — gate on a
      // project being open. Without this the call falls through to
      // provision_auth or scaffolding tools which fail with cryptic errors.
      if (!path) {
        useChatStore.getState().addSystemMessage(
          'No project open. Open a project before using skill hashtags.',
          'error',
        )
        return
      }

      // Smart router: if any requested auth provider is already applied,
      // block the re-scaffold flow with explanatory system message. Same
      // parity as chat-mode usePromptBar.
      if (pre.authProviders.length > 0) {
        const { guardScaffoldReapply } = await import('../components/prompt/scaffoldReapplyGuard')
        const requestedKeys: import('../services/scaffoldingDetector').ScaffoldKey[] =
          pre.authProviders.map(p => `auth.${p}` as const)
        const { blocked } = await guardScaffoldReapply(
          path,
          requestedKeys,
          (applied) => buildCmdAuthReapplyMessage(applied),
          () => { /* cmd-mode has no draftInput state to clear */ },
        )
        if (blocked) return
      }

      // Preserve hashtags in the visible message and the persisted history.
      // The hashtag is still useful AFTER it routes — it documents the user's
      // intent for anyone reading the session later (debug exports, sharing
      // a repro, scrolling back), and it's what they actually typed. The
      // skill content is force-loaded via runAuthFlow regardless of what
      // appears in the bubble, so stripping the tag here used to delete
      // signal for no behavioural gain.
      const bubbleText = textPrompt

      // cmdOnlyMode=true so runAgentWithCallbacks calls toolExecutor.enableCmdMode(cwd).
      // Without this, hashtag flows in CMD mode fail every tool call with
      // "No project is open" — the executor falls back to useProjectStore.currentProject,
      // which TerminalView never populates (it invokes Rust open_project directly
      // instead of going through useProjectStore.openProject).
      if (pre.authProviders.length > 0) {
        await runAuthFlow(pre.authProviders, pre.cleanedText, bubbleText, pre.hasDesign, true)
      } else {
        await runDesignFlow(pre.cleanedText, bubbleText, true)
      }
      return
    }

    // ── Agent prompt ──
    const { isAuthenticated } = useAuthStore.getState()
    if (!isAuthenticated) {
      useChatStore.getState().addSystemMessage('You must be signed in to use the agent.', 'error')
      return
    }

    // Render the user bubble FIRST — synchronously, before any await — so the
    // dequeued message appears in the transcript without a perceptible gap.
    // Previously, mention resolution + runAgentWithCallbacks's `await prev` +
    // `await invoke('get_home_directory')` chain delayed addUserMessage by
    // 100ms–1s, leaving the user staring at an empty list right after the
    // queued pill disappeared.
    const attachments = typeof promptValue === 'string'
      ? undefined
      : promptValue.filter(b => b.type === 'attachment').map(b => b.attachment)
    const promptBlocks = typeof promptValue === 'string' ? undefined : promptValue
    const chatStore = useChatStore.getState()
    if (!chatStore.activeSessionId) {
      chatStore.createSession(path)
    }
    chatStore.addUserMessage(textPrompt, attachments, promptBlocks)

    // Resolve @mentions before sending — appends <mentioned_files> context to the prompt
    const mentionContext = path ? await extractAndResolveMentions(textPrompt, path) : ''
    const fullPrompt = mentionContext ? `${textPrompt}\n\n${mentionContext}` : textPrompt

    await runAgentWithCallbacks(fullPrompt, {
      addUserMessage: false,
      userMessageText: textPrompt,
      userMessageAttachments: attachments,
      userMessageBlocks: promptBlocks,
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

    // Mode 1: command name (no space yet) → suggest commands
    if (value.startsWith('/') && !value.includes(' ')) {
      const firstWord = value.split(' ')[0]
      const commands = filterCommands(firstWord, allCommands)
      setFilteredCommands(commands)
      setShowCommandMenu(commands.length > 0)
      setSelectedCommandIndex(0)
      setShowMentionMenu(false)
      setIsArgMode(false)
      return
    }

    // Mode 2: typed `<known-cmd> [partial]` → suggest argument values for the
    // command. Synthesised as SlashCommand-shaped items so the existing menu
    // and key-nav logic keep working unchanged.
    const argResult = slashCommandRegistry.getArgSuggestions(value)
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
      setShowMentionMenu(false)
      setIsArgMode(true)
      return
    }

    setShowCommandMenu(false)
    setIsArgMode(false)

    const cursorPos = textareaRef.current?.selectionStart ?? value.length

    // Closed-vocabulary hashtag (e.g. #auth-email-password, #auth-google).
    // detect() returns true when a `#` token owns the autocomplete slot —
    // including the no-matches case — so we never fall through to the file
    // picker for an unknown tag.
    if (hashtagMenu.detect(value, cursorPos)) {
      setShowMentionMenu(false)
      setMentionQuery('')
      mentionStartRef.current = -1
      return
    }

    // @mention detection — unicode-safe, shared with chat prompt & resolver.
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
    // Arg mode: the picked item is a synthesised arg suggestion (not a real
    // slash command). Detect by checking whether the current input already
    // includes a space — we only enter arg-suggest mode after the command
    // name + space.
    if (input.includes(' ')) {
      setInput(prev => {
        const lastSpaceIdx = prev.lastIndexOf(' ')
        const prefix = prev.slice(0, lastSpaceIdx + 1)
        const next = prefix + command.name + ' '
        // Re-evaluate the menu so chained arg picks auto-advance.
        const argResult = slashCommandRegistry.getArgSuggestions(next)
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
        textareaRef.current?.focus()
        return next
      })
      return
    }

    // Command mode: real command pick. No-arg commands run immediately;
    // commands that accept args get the trailing space + focus.
    setShowCommandMenu(false)
    setIsArgMode(false)
    if (NO_ARG_COMMANDS.has(command.name)) {
      setInput('')
      // Fire-and-forget: executePrompt has side effects (toggle, agent calls)
      // that must NOT run inside a React state updater.
      executePrompt(command.name)
      return
    }
    setInput(command.name + ' ')
    textareaRef.current?.focus()
  }, [input, executePrompt])

  const handleSend = useCallback(async () => {
    const prompt = input.trim()
    const hasAttachments = draftAttachments.length > 0
    if (!prompt && !hasAttachments) return

    // Billing gate for image attachments — the bar already shows a warning,
    // but prior behaviour silently let the send go through, which either
    // consumed tokens for nothing (explorer plan strips images) or confused
    // the user. Block here with an actionable message instead.
    if (showImageWarning) {
      useChatStore.getState().addSystemMessage(
        t('terminalMode.imageNotSupportedBlocked'),
        'warn',
      )
      return
    }

    setInput('')
    setShowCommandMenu(false)
    setShowMentionMenu(false)
    hashtagMenu.close()

    historyRef.current = [prompt, ...historyRef.current.filter(h => h !== prompt)].slice(0, MAX_PROMPT_HISTORY)
    historyIndexRef.current = -1
    // Persist asynchronously — never blocks send. Never throws (service swallows IDB errors).
    if (prompt && projectPath) {
      void savePromptHistory(projectPath, historyRef.current)
    }

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
  }, [input, isStreaming, executePrompt, draftAttachments, clearAttachments, showImageWarning])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // #hashtag menu — shared hook returns true when the key was consumed.
      // Mutually exclusive with the mention menu but listed first to match
      // the priority enforced by handleInputChange.
      if (hashtagMenu.handleKeyDown(e)) return

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
      if (!showCommandMenu && !showMentionMenu && !hashtagMenu.show) {
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

      // Control keys — when the terminal panel is open, forward common
      // shell control sequences to the PTY instead of letting the browser
      // handle them (copy, undo, bookmark, etc.). Only `ctrlKey` is used
      // (not `metaKey`) so Cmd+C on macOS still copies text from the
      // textarea.
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        const terminalOpen = useTerminalPanelStore.getState().isOpen
        // Ctrl+X closes the terminal panel when open; when closed, allow
        // native cut (Ctrl+X) to work in the textarea.
        if (e.key === 'x' && terminalOpen) {
          e.preventDefault()
          e.stopPropagation()
          useTerminalPanelStore.getState().toggle()
          return
        }
        if (terminalOpen) {
          const CONTROL_MAP: Record<string, string> = {
            c: '\x03',  // SIGINT
            z: '\x1a',  // SIGTSTP
            d: '\x04',  // EOF
            l: '\x0c',  // clear screen
          }
          const seq = CONTROL_MAP[e.key]
          if (seq) {
            e.preventDefault()
            e.stopPropagation()
            useTerminalPanelStore.getState().writeToPty(seq)
            textareaRef.current?.blur()
            return
          }
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
      hashtagMenu,
      input, queuedCommands,
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
    isArgMode,
    showMentionMenu,
    filteredMentions,
    selectedMentionIndex,
    mentionQuery,
    quickOpenBuilding,
    hashtagMenu,
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

// ── Scaffold-reapply system messages (cmd-mode parity with chat-mode) ──
// Same wording as chat-mode usePromptBar so the UX is consistent. Pure
// builders; resolved through i18n at call time.

function buildCmdAuthReapplyMessage(
  applied: import('../services/scaffoldingDetector').ScaffoldKey[],
): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { scaffoldKeyLabel } = require('../services/scaffoldingDetector') as typeof import('../services/scaffoldingDetector')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { t } = require('../i18n') as typeof import('../i18n')
  const labels = applied.map(scaffoldKeyLabel).join(' + ')
  const fixHint = applied.includes('auth.google')
    ? t('scaffold.message.authFixHintGoogle')
    : t('scaffold.message.authFixHintEmail')
  return t('scaffold.message.authReapply')
    .replace('{labels}', labels)
    .replace('{fixHint}', fixHint)
}

function buildCmdPaymentsReapplyMessage(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { t } = require('../i18n') as typeof import('../i18n')
  return t('scaffold.message.paymentsReapply')
}
