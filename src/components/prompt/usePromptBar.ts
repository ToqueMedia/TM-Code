import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useChatStore, appendTextDeltaBuffered, appendReasoningDeltaBuffered, flushBufferedDeltas, resolveAllPendingDiffApprovals } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useAuthStore } from '../../stores/authStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useProblemsStore } from '../../stores/problemsStore'
import { devServerManager } from '../../services/devServerManager'
import AgentService from '../../services/agent/agentService'
import ToolExecutor from '../../services/agent/toolExecutor'
import ContextBuilder from '../../services/agent/contextBuilder'
import MCPService from '../../services/mcp/mcpService'
import { slashCommandRegistry, type SlashCommand } from '../../services/agent/slashCommandRegistry'
import QuickOpenService, { type QuickOpenItem } from '../../services/quickOpenService'
import { createAttachmentFromPath, createImageAttachmentFromClipboard, resolveAttachments, extractAndResolveMentions } from '../../services/attachmentService'
import type { Attachment } from '../../types/chat'
import {
  enqueue as enqueueMessage,
  clearCommandQueue as clearMessageQueue,
  joinPromptValues,
} from '../../services/agent/messageQueue'
import { getQueryGuard } from '../../services/agent/queryGuard'
import type { QueuedCommand } from '../../types/messageQueueTypes'
import { useQueueProcessor } from '../../hooks/useQueueProcessor'
import { logger } from '../../utils/logger'

export function usePromptBar() {
  const input = useChatStore(s => s.draftInput)
  const setInput = useChatStore(s => s.setDraftInput)
  const [devCommand, setDevCommand] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const runningRef = useRef(false)
  /** Abort controller for the queue processing loop — allows handleStop to cancel it. */
  const queueAbortRef = useRef<AbortController | null>(null)
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const historyIndexRef = useRef(-1)
  const savedDraftRef = useRef('')
  const navigatingHistoryRef = useRef(false)
  const isStreaming = useChatStore(s => s.isStreaming)
  const hasPendingPermission = usePermissionStore(s => !!s.pendingPermission)
  // Subscribe to the QueryGuard via useSyncExternalStore — same pattern
  // Claude Code uses. Re-renders when reserve/tryStart/end/forceEnd fires.
  const queryGuard = getQueryGuard()
  const isAgentBusy = useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot)
  const currentProject = useProjectStore(s => s.currentProject)
  const viewMode = useLayoutStore(s => s.viewMode)
  const isPreviewServerRunning = useLayoutStore(s => s.isPreviewServerRunning)
  const previewHtmlContent = useLayoutStore(s => s.previewHtmlContent)
  const scaffoldPhase = useLayoutStore(s => s.scaffoldPhase)
  const isScaffolding = scaffoldPhase === 'installing' || scaffoldPhase === 'starting'
  // Input is always active — user can type and enqueue while agent is busy.
  // Only disable during permission dialogs (user must respond first).
  const isDisabled = hasPendingPermission
  // Send is only blocked during scaffolding (deps install / server start).
  const isSendBlocked = isScaffolding
  const hasPreview = isPreviewServerRunning || !!previewHtmlContent || !!devCommand

  // Slash command menu state
  const [showCommandMenu, setShowCommandMenu] = useState(false)
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([])
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)

  // @mention menu state
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  const [filteredMentions, setFilteredMentions] = useState<QuickOpenItem[]>([])
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const mentionStartRef = useRef(-1)

  // Drag-and-drop visual state (local, NOT in Zustand store)
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)

  // Draft attachments from store
  const draftAttachments = useChatStore(s => s.draftAttachments)
  const addDraftAttachment = useChatStore(s => s.addDraftAttachment)
  const removeDraftAttachment = useChatStore(s => s.removeDraftAttachment)
  const clearDraftAttachments = useChatStore(s => s.clearDraftAttachments)

  // Cleanup blur timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    }
  }, [])

  // Detect if project can run a dev server
  useEffect(() => {
    if (!currentProject?.path) {
      setDevCommand(null)
      return
    }

    let cancelled = false
    const projectPath = currentProject.path

    async function detect() {
      // 1. Check .toquemedia-template manifest
      try {
        const raw = await invoke<string>('read_file', { path: `${projectPath}/.toquemedia-template` })
        if (!cancelled && raw) {
          const manifest = JSON.parse(raw)
          if (manifest.devCommand) {
            setDevCommand(manifest.devCommand)
            return
          }
        }
      } catch { /* no manifest */ }

      // 2. Check package.json for "dev" or "start" script
      try {
        const raw = await invoke<string>('read_file', { path: `${projectPath}/package.json` })
        if (!cancelled && raw) {
          const pkg = JSON.parse(raw)
          if (pkg.scripts?.dev) {
            setDevCommand('npm run dev')
            return
          }
          if (pkg.scripts?.start) {
            setDevCommand('npm start')
            return
          }
        }
      } catch { /* no package.json */ }

      if (!cancelled) setDevCommand(null)
    }

    detect()
    return () => { cancelled = true }
  }, [currentProject?.path])

  // Auto-resize textarea (runs on every input change AND on mount so the
  // preview PromptBar gets the correct height when it mounts with existing text)
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const maxHeight = 6 * 24
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  })

  // Preserve focus across view switches (e.g. chat → preview).
  // When the PromptBar remounts with draft text, the user was typing — refocus.
  useEffect(() => {
    const draft = useChatStore.getState().draftInput
    if (draft && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

  // Slash command input handler — detect "/" prefix and filter commands
  const handleInputChange = useCallback((value: string) => {
    setInput(value)

    // Don't reset history index when the change came from history navigation
    if (navigatingHistoryRef.current) {
      navigatingHistoryRef.current = false
    } else {
      historyIndexRef.current = -1
    }

    // Slash commands: /command
    if (value.startsWith('/') && !value.includes(' ')) {
      const commands = slashCommandRegistry.filterCommands(value.split(' ')[0])
      setFilteredCommands(commands)
      setShowCommandMenu(commands.length > 0)
      setSelectedCommandIndex(0)
      setShowMentionMenu(false)
      return
    }
    setShowCommandMenu(false)

    // @mention detection — scan backward from cursor to find '@' trigger
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return

      const cursorPos = textarea.selectionStart
      const val = textarea.value

      // Scan backward from cursor to find '@'
      let atIndex = -1
      for (let i = cursorPos - 1; i >= 0; i--) {
        const ch = val[i]
        if (ch === '@') {
          if (i === 0 || /\s/.test(val[i - 1])) {
            atIndex = i
          }
          break
        }
        if (/\s/.test(ch)) break
      }

      if (atIndex === -1) {
        setShowMentionMenu(false)
        return
      }

      const query = val.slice(atIndex + 1, cursorPos)
      const qs = QuickOpenService.getInstance()
      const results = query.length === 0 ? qs.list(8) : qs.search(query, 8)

      if (results.length > 0) {
        setFilteredMentions(results)
        setShowMentionMenu(true)
        setSelectedMentionIndex(0)
        mentionStartRef.current = atIndex
      } else {
        setShowMentionMenu(false)
      }
    })
  }, [setInput])

  const handleCommandSelect = useCallback((command: SlashCommand) => {
    setInput(command.name + ' ')
    setShowCommandMenu(false)
    textareaRef.current?.focus()
  }, [setInput])

  const handleBlur = useCallback(() => {
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
    blurTimeoutRef.current = setTimeout(() => {
      setShowCommandMenu(false)
      setShowMentionMenu(false)
    }, 150)
  }, [])

  // @mention selection: insert @path as text in the textarea (like reference impl)
  const handleMentionSelect = useCallback((item: QuickOpenItem) => {
    const currentInput = useChatStore.getState().draftInput
    const start = mentionStartRef.current
    if (start < 0) return

    const cursorPos = textareaRef.current?.selectionStart ?? currentInput.length
    const before = currentInput.slice(0, start)
    const after = currentInput.slice(cursorPos)

    // Get relative path from project root
    const projectPath = useProjectStore.getState().currentProject?.path || ''
    const relativePath = item.path.startsWith(projectPath + '/')
      ? item.path.slice(projectPath.length + 1)
      : item.path

    const insertion = `@${relativePath} `
    const newValue = before + insertion + after
    const newCursor = before.length + insertion.length

    // Update store directly (bypass handleInputChange to avoid re-triggering detection)
    useChatStore.getState().setDraftInput(newValue)
    mentionStartRef.current = -1
    setShowMentionMenu(false)

    // Set cursor position after React re-renders
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (textarea) {
        textarea.selectionStart = newCursor
        textarea.selectionEnd = newCursor
        textarea.focus()
      }
    })
  }, [])

  // Attach files via file picker dialog
  const handleAttachFiles = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: true,
        title: 'Attach files',
      })
      if (!selected) return
      const paths = Array.isArray(selected) ? selected : [selected]
      for (const p of paths) {
        try {
          const attachment = await createAttachmentFromPath(p as string)
          addDraftAttachment(attachment)
        } catch (err) {
          logger.error('prompt', 'Failed to attach file:', err)
        }
      }
    } catch (err) {
      logger.error('prompt', 'Failed to open file dialog:', err)
    }
    textareaRef.current?.focus()
  }, [addDraftAttachment])

  // Paste handler — intercept images from clipboard
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (!blob) continue
        try {
          const attachment = await createImageAttachmentFromClipboard(blob)
          addDraftAttachment(attachment)
        } catch (err) {
          logger.error('prompt', 'Failed to paste image:', err)
        }
        return // Only handle first image
      }
    }
    // If no image, let default paste behavior (text) proceed
  }, [addDraftAttachment])

  // Drag-and-drop handlers — counter prevents flicker when dragging over child elements
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragging(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragging(false)

    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file.type.startsWith('image/')) {
        try {
          const attachment = await createImageAttachmentFromClipboard(file)
          addDraftAttachment(attachment)
        } catch (err) {
          logger.error('prompt', 'Failed to attach dropped image:', err)
        }
      }
      // Note: In Tauri WebView, dropped non-image files may not have full paths.
      // For file references, users should use @ mentions or the attach button.
    }
    textareaRef.current?.focus()
  }, [addDraftAttachment])

  const handleRemoveAttachment = useCallback((id: string) => {
    removeDraftAttachment(id)
  }, [removeDraftAttachment])

  // Listen for suggestion chip inserts
  useEffect(() => {
    function handleInsert(e: Event) {
      const ce = e as CustomEvent<string>
      if (ce.detail) {
        setInput(ce.detail)
        textareaRef.current?.focus()
      }
    }
    window.addEventListener('promptbar:insert', handleInsert)
    return () => window.removeEventListener('promptbar:insert', handleInsert)
  }, [])

  /**
   * Core send logic — runs the agent loop for a given prompt.
   * Extracted so both handleSend (direct) and executeQueuedInput (from queue) can use it.
   *
   * @param skipUserMessage - If true, don't add user message to chat (already added by caller).
   */
  const runAgentForPrompt = useCallback(async (
    prompt: string,
    attachments: Attachment[],
    skipUserMessage = false,
  ) => {
    let chatStore = useChatStore.getState()
    const agentStore = useAgentStore.getState()

    let sessionId = chatStore.activeSessionId
    if (!sessionId) {
      const projectPath = currentProject?.path || ''
      sessionId = await chatStore.createNewSession(projectPath)
    }

    // Re-read state after potential async createNewSession to get fresh conversationHistory
    chatStore = useChatStore.getState()

    // If preview is open, switch to chat so the user sees the agent working
    const layoutStore = useLayoutStore.getState()
    if (layoutStore.viewMode === 'preview') {
      layoutStore.setViewMode('chat')
    }

    // Resolve @mentions from text + chip attachments
    const projectPath = currentProject?.path || ''
    const projectType = currentProject?.projectType || 'unknown'
    let augmentedPrompt = prompt || 'Analyze the attached files.'

    // Extract inline @mentions from the prompt text
    const mentionContext = await extractAndResolveMentions(augmentedPrompt, projectPath)
    if (mentionContext) {
      augmentedPrompt = augmentedPrompt + mentionContext
    }

    // Resolve chip attachments (images, files from paperclip button)
    if (attachments.length > 0) {
      const attachmentContext = await resolveAttachments(attachments)
      augmentedPrompt = augmentedPrompt + attachmentContext
    }

    // Display the original prompt (without file contents) in the chat bubble.
    // The augmented version (with file contents) is only sent to the model.
    // Skip if caller already added the message (e.g. queued commands).
    if (!skipUserMessage) {
      chatStore.addUserMessage(prompt, attachments)
    }
    chatStore.startAssistantMessage()
    agentStore.setStatus('thinking')

    // Track whether the agent loop ended with an error.
    // Used by executeQueuedInput to stop processing remaining commands.
    let hadError = false

    try {
      // Refresh MCP tools before building prompt (handles mid-session server changes)
      const mcpService = MCPService.getInstance()
      const mcpTools = mcpService.getAllTools()
      if (mcpTools.length > 0) {
        const toolExecutor = ToolExecutor.getInstance()
        toolExecutor.registerMCPTools(mcpTools, (serverName, toolName, args) =>
          mcpService.callTool(serverName, toolName, args)
        )
        AgentService.getInstance().refreshTools()
      }

      // Build system prompt with MCP tool info for the tool_routing section
      const contextBuilder = ContextBuilder.getInstance()
      const mcpToolSummaries = mcpTools.map(t => ({
        name: t.name,
        description: t.description,
        serverName: t.serverName,
      }))
      const coreToolCount = ToolExecutor.getInstance().getCoreToolCount()
      const systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, projectType, mcpToolSummaries, coreToolCount)

      const history = useChatStore.getState().conversationHistory
      const agentService = AgentService.getInstance()
      agentService.setSystemPrompt(systemPrompt)

      await agentService.runAgentLoop(augmentedPrompt, history, {
        onTextDelta: (delta) => {
          agentStore.setStatus('generating')
          appendTextDeltaBuffered(delta)
        },
        onReasoningDelta: (delta) => {
          agentStore.setStatus('thinking')
          appendReasoningDeltaBuffered(delta)
        },
        onToolCallPending: (toolId, toolName) => {
          flushBufferedDeltas()
          agentStore.setStatus('applying')
          useChatStore.getState().addPendingToolCall(toolId, toolName)
        },
        onToolCallStart: (toolId, _toolName, args) => {
          useChatStore.getState().updateToolCallWithArgs(toolId, args)
        },
        onToolResult: (toolId, _toolName, result, isError) => {
          useChatStore.getState().updateToolCallWithResult(toolId, result, isError)
          agentStore.setStatus('thinking')
        },
        onTurnComplete: () => {
          useChatStore.getState().incrementTurnCount()
        },
        onDone: async () => {
          flushBufferedDeltas()
          useChatStore.getState().finalizeAssistantMessage()
          agentStore.setStatus('idle')

          // Re-scan project diagnostics after agent finishes
          useProblemsStore.getState().scanProject().catch(() => {})

          const layoutStore = useLayoutStore.getState()

          // If preview server is running, reload and show preview
          if (layoutStore.isPreviewServerRunning) {
            layoutStore.reloadPreview()
            layoutStore.setViewMode('preview')
            return
          }

          // If a server is already starting (e.g. postScaffoldPipeline kicked
          // it off and waitForServerReady hasn't resolved yet), don't start a
          // second one — the first will auto-transition when ready.
          if (devServerManager.isActive()) return

          // Otherwise, try to start preview if we have a dev command
          if (devCommand && currentProject?.path) {
            layoutStore.addDevServerLog(`Starting dev server (${devCommand})...`, 'info')
            try {
              await devServerManager.start(currentProject.path, devCommand)
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              layoutStore.addDevServerLog(`Could not start dev server: ${msg}`, 'error')
            }
          }
        },
        onError: (error) => {
          flushBufferedDeltas()
          resolveAllPendingDiffApprovals(false)
          agentStore.setStatus('error')
          agentStore.setError(error.message)
          useChatStore.getState().finalizeAssistantMessage()
          hadError = true
        },
        onUsageUpdate: (inputTokens, outputTokens) => {
          useChatStore.getState().addTokenUsage(inputTokens, outputTokens)
        },
        onContextCompression: (beforeTokens, signal) => {
          if (signal === 0) {
            // Compression starting
            agentStore.setStatus('compressing')
            useChatStore.getState().addSystemMessage(
              `Comprimindo contexto (${Math.round(beforeTokens / 1000)}K tokens)...`
            )
          } else if (signal === -1) {
            // Compression complete
            agentStore.setStatus('thinking')
          }
        },
      })
    } catch (error) {
      // Cleanup if anything fails before or during runAgentLoop setup.
      // Prevents isStreaming/agentStatus getting stuck.
      flushBufferedDeltas()
      useChatStore.getState().finalizeAssistantMessage()
      agentStore.setStatus('idle')
      logger.error('prompt', 'runAgentForPrompt failed:', error)
      hadError = true
    }

    return !hadError
  }, [currentProject, devCommand])

  const handleSend = useCallback(async () => {
    const prompt = useChatStore.getState().draftInput.trim()
    const hasAttachments = useChatStore.getState().draftAttachments.length > 0
    if (!prompt && !hasAttachments) return
    if (usePermissionStore.getState().pendingPermission) return
    const phase = useLayoutStore.getState().scaffoldPhase
    if (phase === 'installing' || phase === 'starting') return

    // Check authentication
    const { isAuthenticated } = useAuthStore.getState()
    if (!isAuthenticated) return

    // Reset prompt history navigation
    historyIndexRef.current = -1
    savedDraftRef.current = ''

    // Close command menu
    setShowCommandMenu(false)

    // Check if it's a slash command — these are never queued
    if (slashCommandRegistry.isSlashCommand(prompt)) {
      const command = slashCommandRegistry.getCommand(prompt)
      if (!command) return

      if (!command.enabled) {
        useChatStore.getState().setDraftInput('')
        clearDraftAttachments()
        useChatStore.getState().addSystemMessage(`Command ${command.name} is not yet available.`)
        return
      }

      const projectPath = currentProject?.path
      if (!projectPath) {
        useChatStore.getState().setDraftInput('')
        clearDraftAttachments()
        useChatStore.getState().addSystemMessage('No project open. Open a project first.')
        return
      }

      useChatStore.getState().setDraftInput('')
      clearDraftAttachments()

      // Switch to chat so the user sees the agent working
      const layout = useLayoutStore.getState()
      if (layout.viewMode !== 'chat') {
        layout.setViewMode('chat')
      }

      const args = slashCommandRegistry.getArgs(prompt)
      await command.execute(args, projectPath)
      return
    }

    // === Agent is busy — enqueue the message ===
    if (isAgentBusy) {
      const attachments = [...useChatStore.getState().draftAttachments]

      // Enqueue with mode='prompt' priority='next' (the user-input default).
      // The message will be added to chat when the queue processor pulls it
      // out; until then it's visible in QueuedMessagesPreview above the input.
      enqueueMessage({
        value: prompt,
        mode: 'prompt',
        priority: 'next',
        uuid: crypto.randomUUID(),
        ...(attachments.length > 0 && { pastedContents: attachments }),
      })

      // Clear input
      useChatStore.getState().setDraftInput('')
      clearDraftAttachments()

      logger.info('queue', `Message enqueued: "${prompt.slice(0, 50)}..."`)
      return
    }

    // === Agent is idle — run directly ===

    // Non-reentrant guard: prevent overlapping sends
    if (runningRef.current) return
    runningRef.current = true

    try {
      useChatStore.getState().setDraftInput('')
      const attachments = useChatStore.getState().draftAttachments
      clearDraftAttachments()

      // Switch to chat so the user sees the agent working
      const layoutStore = useLayoutStore.getState()
      if (layoutStore.viewMode !== 'chat') {
        layoutStore.setViewMode('chat')
      }

      await runAgentForPrompt(prompt, attachments)
    } finally {
      runningRef.current = false
    }
  }, [currentProject, devCommand, isAgentBusy, runAgentForPrompt])

  const handleStop = useCallback(() => {
    // Clear the message queue BEFORE cancelling — prevents useQueueProcessor
    // from firing when queryGuard transitions to idle.
    clearMessageQueue()
    // Abort the queue processing loop (if running) so it doesn't
    // continue to the next command after the current one is cancelled.
    queueAbortRef.current?.abort()
    // Clear any pending permission first — resolves the dangling Promise
    usePermissionStore.getState().clearPending()
    // Resolve any pending diff approval waits (rejects them)
    resolveAllPendingDiffApprovals(false)
    AgentService.getInstance().cancelLoop()
    useAgentStore.getState().setStatus('idle')
    useChatStore.getState().finalizeAssistantMessage()
  }, [])

  // === Queue processor — runs queued commands when agent becomes idle ===
  //
  // `commands` is whatever processQueueIfReady decided to drain:
  //  - Slash/bash modes: a single command (one at a time).
  //  - Prompt mode: all consecutive prompt-mode commands batched together.
  //  - Task notifications: all task-notification commands batched together.
  //
  // For prompt mode we additionally coalesce the values into a single
  // agent turn (Claude Code's joinPromptValues), so 3 quick messages
  // become ONE round-trip to the model instead of three. Attachments
  // from all batched commands are concatenated.
  //
  // After the agent loop returns, the QueryGuard transitions back to
  // idle and useQueueProcessor's effect re-fires, picking up anything
  // that was enqueued while we were running. No manual dequeueAll loop
  // is needed here — the React effect IS the loop.
  const executeQueuedInput = useCallback(async (commands: QueuedCommand[]) => {
    if (runningRef.current) return
    if (commands.length === 0) return
    runningRef.current = true

    // Create an abort controller so handleStop can cancel the loop
    const abortController = new AbortController()
    queueAbortRef.current = abortController

    try {
      // Switch to chat so the user sees the agent working
      const layoutStore = useLayoutStore.getState()
      if (layoutStore.viewMode !== 'chat') {
        layoutStore.setViewMode('chat')
      }

      const head = commands[0]!
      // Coalesce prompt-mode batches into a single turn.
      let mergedValue: string
      let mergedAttachments: typeof head.pastedContents
      if (head.mode === 'prompt' && commands.length > 1) {
        mergedValue = joinPromptValues(commands.map(c => c.value))
        // Concatenate attachments across batched commands, preserving order.
        const all: NonNullable<typeof head.pastedContents> = []
        for (const c of commands) {
          if (c.pastedContents) all.push(...c.pastedContents)
        }
        mergedAttachments = all.length > 0 ? all : undefined
      } else {
        mergedValue = head.value
        mergedAttachments = head.pastedContents
      }

      if (abortController.signal.aborted) return

      // Add the (possibly coalesced) user message to chat now.
      useChatStore.getState().addUserMessage(mergedValue, mergedAttachments ?? [])

      await runAgentForPrompt(mergedValue, mergedAttachments ?? [], true)
      // Result intentionally ignored: if the agent errored, the next batch
      // (if any) will be picked up by the effect when it re-fires. The
      // user-visible error is already in the chat transcript.
    } finally {
      queueAbortRef.current = null
      runningRef.current = false
    }
  }, [runAgentForPrompt])

  useQueueProcessor({ executeQueuedInput })

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // @mention menu navigation — takes priority when open
      if (showMentionMenu && filteredMentions.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedMentionIndex(prev => prev <= 0 ? filteredMentions.length - 1 : prev - 1)
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedMentionIndex(prev => prev >= filteredMentions.length - 1 ? 0 : prev + 1)
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
          e.preventDefault()
          const selected = filteredMentions[selectedMentionIndex]
          if (selected) handleMentionSelect(selected)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowMentionMenu(false)
          return
        }
      }

      // Prompt history navigation (Up/Down when menu is NOT open)
      // ArrowUp: only navigate to previous history if cursor is at the START of text (position 0)
      // ArrowDown: only navigate to next history if cursor is at the END of text
      // Otherwise, let the arrow keys move the cursor normally within the text
      if (!showCommandMenu && !showMentionMenu && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const textarea = textareaRef.current
        if (!textarea) return

        const cursorPos = textarea.selectionStart
        const textLen = textarea.value.length
        const hasSelection = textarea.selectionStart !== textarea.selectionEnd

        // Don't navigate history if there's a text selection — let arrow keys collapse it
        if (hasSelection) return
        if (e.key === 'ArrowUp' && cursorPos !== 0) return
        if (e.key === 'ArrowDown' && cursorPos !== textLen) return

        const session = useChatStore.getState().getActiveSession()
        if (!session) return

        // Get user messages as history (most recent last, deduplicated)
        const history: string[] = []
        for (const m of session.messages) {
          if (m.role === 'user' && m.content.trim()) {
            const text = m.content
            if (history.length === 0 || history[history.length - 1] !== text) {
              history.push(text)
            }
          }
        }

        if (history.length === 0) return

        if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (historyIndexRef.current === -1) {
            savedDraftRef.current = useChatStore.getState().draftInput
          }
          if (historyIndexRef.current < history.length - 1) {
            historyIndexRef.current++
            navigatingHistoryRef.current = true
            const entry = history[history.length - 1 - historyIndexRef.current]
            setInput(entry)
            // Place cursor at start so consecutive ArrowUp navigates immediately
            requestAnimationFrame(() => {
              if (textarea) { textarea.selectionStart = 0; textarea.selectionEnd = 0 }
            })
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (historyIndexRef.current > 0) {
            historyIndexRef.current--
            navigatingHistoryRef.current = true
            const entry = history[history.length - 1 - historyIndexRef.current]
            setInput(entry)
            // Place cursor at end so consecutive ArrowDown navigates immediately
            requestAnimationFrame(() => {
              if (textarea) { textarea.selectionStart = entry.length; textarea.selectionEnd = entry.length }
            })
          } else if (historyIndexRef.current === 0) {
            historyIndexRef.current = -1
            navigatingHistoryRef.current = true
            setInput(savedDraftRef.current)
            requestAnimationFrame(() => {
              if (textarea) {
                const len = savedDraftRef.current.length
                textarea.selectionStart = len; textarea.selectionEnd = len
              }
            })
          }
        }
        setShowCommandMenu(false)
        return
      }

      // Slash command menu navigation
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
          if (selected) handleCommandSelect(selected)
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
    [handleSend, showCommandMenu, filteredCommands, selectedCommandIndex, handleCommandSelect, showMentionMenu, filteredMentions, selectedMentionIndex, handleMentionSelect]
  )

  const toggleEditor = useCallback(() => {
    const layoutStore = useLayoutStore.getState()
    if (layoutStore.viewMode === 'editor') {
      layoutStore.goBack()
    } else {
      layoutStore.setViewMode('editor')
    }
  }, [])

  const togglePreview = useCallback(async () => {
    const layoutStore = useLayoutStore.getState()

    if (layoutStore.viewMode === 'preview') {
      layoutStore.goBack()
      return
    }

    // If server is already running or static preview exists, just switch view
    if (layoutStore.isPreviewServerRunning || layoutStore.previewHtmlContent) {
      layoutStore.setViewMode('preview')
      return
    }

    // If server is already starting, don't restart
    if (devServerManager.isActive()) return

    // No server running — start one if we have a devCommand
    if (devCommand && currentProject?.path) {
      const layout = useLayoutStore.getState()
      layout.addDevServerLog(`Starting dev server (${devCommand})...`, 'info')
      try {
        await devServerManager.start(currentProject.path, devCommand)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        layout.addDevServerLog(`Could not start dev server: ${msg}`, 'error')
      }
    }
  }, [devCommand, currentProject?.path])

  return {
    input,
    setInput: handleInputChange,
    textareaRef,
    isStreaming,
    isAgentBusy,
    isScaffolding,
    isSendBlocked,
    isDisabled,
    viewMode,
    hasPreview,
    handleSend,
    handleStop,
    handleKeyDown,
    handleBlur,
    toggleEditor,
    togglePreview,
    // Slash command menu
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    handleCommandSelect,
    // @mention menu
    showMentionMenu,
    filteredMentions,
    selectedMentionIndex,
    handleMentionSelect,
    // Attachments
    draftAttachments,
    handleAttachFiles,
    handlePaste,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    handleRemoveAttachment,
    isDragging,
  }
}
