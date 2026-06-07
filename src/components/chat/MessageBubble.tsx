import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiUser, FiCopy, FiCheck, FiDownload, FiCode, FiFileText } from 'react-icons/fi'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { ChatMessage } from '../../types/chat'
import { useChatStore } from '../../stores/chatStore'
import { renderHighlightedPrompt } from '../prompt/promptHighlight'
import CodeBlockAction from './CodeBlockAction'
import ToolCallDisplayComponent from './ToolCallDisplay'
import ReadOutputBatch from './ReadOutputBatch'
import { groupConsecutiveLargeReads, computeContentBlockBatches } from '../../utils/groupToolCalls'
import { isAgentShellTool, ShellSessionBlock } from '../shell/ShellCommandBlock'
import AgentLogo from '../ui/AgentLogo'
import CompactSummary from './CompactSummary'
import ReasoningBlock from './ReasoningBlock'
import PlanApprovalCard from './PlanApprovalCard'
import TodoListCard from './TodoListCard'
import CredentialRequestCard from './CredentialRequestCard'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import SubAgentCard from './SubAgentCard'
import {
  sessionToJson,
  sessionToMarkdown,
  triggerDownload,
  defaultExportFilename,
  buildEnvironmentSnapshot,
} from '../../utils/sessionExport'
import { useToastStore } from '../../stores/toastStore'
import { normalizeAssistantText } from '../../utils/normalizeAssistantText'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

/**
 * Toggle a reasoning block while keeping the clicked header in the SAME
 * visual position. The previous approach snapshot raw `scrollTop` and
 * restored it after the toggle — that fails when the toggle changes the
 * height of content ABOVE the user's viewport, because scrollTop counted
 * from the top moves the user to a different region of content than they
 * were reading.
 *
 * Rect-based approach: snapshot `anchor.getBoundingClientRect().top`
 * BEFORE the toggle (the anchor's distance from the viewport top), run the
 * toggle, then in each of the next ~12 frames re-measure and adjust
 * `scrollTop` by the delta so the anchor stays put. ~200ms covers the
 * Framer-Motion / Chakra height animations that resolve over multiple
 * frames; the loop exits early when the rect stabilises.
 */
function toggleReasoningPreservingScroll(anchor: HTMLElement, toggle: () => void): void {
  const scrollEl = document.querySelector('[role="log"]') as HTMLElement | null
  if (!scrollEl) { toggle(); return }
  const beforeTop = anchor.getBoundingClientRect().top
  // Layer 1: signal "user scrolled away" so useStickToBottom doesn't try
  // to auto-follow the resize. A 1-px nudge synchronously fires a scroll
  // event the package treats as user interaction.
  const beforeScroll = scrollEl.scrollTop
  scrollEl.scrollTop = Math.max(0, beforeScroll - 1)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('chat-toggle-interaction'))
  }
  toggle()
  // Layer 2: keep the anchor at the same viewport-y across frames.
  let frames = 0
  const stabilize = () => {
    const afterTop = anchor.getBoundingClientRect().top
    const delta = afterTop - beforeTop
    if (Math.abs(delta) > 1) {
      scrollEl.scrollTop += delta
    }
    if (frames++ < 12) requestAnimationFrame(stabilize)
  }
  requestAnimationFrame(stabilize)
}

interface MessageBubbleProps {
  message: ChatMessage
  isStreaming?: boolean
}

export const markdownStyles = {
  // Prevent long unbreakable strings (URLs, file paths, tool output) from
  // causing horizontal scroll on the entire chat view.
  overflowWrap: 'anywhere' as const,
  wordBreak: 'break-word' as const,

  '& p': {
    margin: '0 0 10px 0',
    lineHeight: '1.75',
    fontSize: '13.5px',
    color: tokens.colors.text.primary,
    letterSpacing: '-0.005em',
  },
  '& p:last-child': { marginBottom: 0 },
  '& strong': { color: '#ffffff', fontWeight: 600 },
  '& em': { color: tokens.colors.markdown.emphasis, fontStyle: 'italic' },
  '& ul, & ol': {
    margin: '6px 0 10px 0',
    paddingLeft: '20px',
    fontSize: '13.5px',
    color: tokens.colors.text.primary,
  },
  '& li': {
    marginBottom: '4px',
    lineHeight: '1.75',
    '&::marker': { color: tokens.colors.text.disabled },
  },
  '& a': {
    color: tokens.colors.accent.primary,
    textDecoration: 'none',
    borderBottom: '1px solid rgba(254, 16, 99, 0.3)',
    transition: 'border-color 0.15s',
    '&:hover': { borderColor: tokens.colors.accent.primary },
  },
  '& code': {
    background: 'rgba(255, 255, 255, 0.07)',
    borderRadius: '5px',
    padding: '2px 7px',
    fontSize: '12px',
    fontFamily: tokens.fontFamily.mono,
    color: '#e6a1c0',
    border: '1px solid rgba(255, 255, 255, 0.05)',
  },
  '& pre': { margin: 0, padding: 0 },
  '& pre code': {
    background: 'none',
    padding: 0,
    border: 'none',
    color: 'inherit',
    borderRadius: 0,
  },
  '& h1, & h2, & h3, & h4': {
    color: '#ffffff',
    fontWeight: 600,
    letterSpacing: '-0.02em',
  },
  '& h1': { fontSize: '20px', margin: '20px 0 10px' },
  '& h2': { fontSize: '17px', margin: '18px 0 8px' },
  '& h3': { fontSize: '15px', margin: '14px 0 6px' },
  '& h4': { fontSize: '13.5px', margin: '12px 0 4px' },
  '& blockquote': {
    borderLeft: `3px solid ${tokens.colors.accent.primaryMuted}`,
    margin: '10px 0',
    paddingLeft: '14px',
    color: tokens.colors.text.secondary,
    fontStyle: 'italic',
  },
  '& hr': {
    border: 'none',
    height: '1px',
    background: tokens.colors.border.subtle,
    margin: '18px 0',
  },
  '& table': {
    borderCollapse: 'collapse' as const,
    width: '100%',
    margin: '10px 0',
    fontSize: '12.5px',
  },
  '& th, & td': {
    border: `1px solid ${tokens.colors.border.subtle}`,
    padding: '7px 12px',
    textAlign: 'left' as const,
  },
  '& th': {
    background: 'rgba(255, 255, 255, 0.03)',
    fontWeight: 600,
    color: '#ffffff',
  },
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [code])

  return (
    <Box
      as="button"
      display="flex"
      alignItems="center"
      gap="5px"
      px="8px"
      py="3px"
      borderRadius="5px"
      bg="transparent"
      color={copied ? tokens.colors.accent.green : tokens.colors.text.disabled}
      fontSize="11px"
      fontFamily={tokens.fontFamily.ui}
      cursor="pointer"
      transition="all 0.15s"
      _hover={{ bg: 'rgba(255,255,255,0.06)', color: tokens.colors.text.secondary }}
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleCopy() }}
    >
      {copied ? <FiCheck size={11} /> : <FiCopy size={11} />}
      {copied ? t('chat.copied') : t('chat.copy')}
    </Box>
  )
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])

  return (
    <Box
      as="button"
      display="flex"
      alignItems="center"
      justifyContent="center"
      w="22px"
      h="22px"
      borderRadius="5px"
      bg="transparent"
      color={copied ? tokens.colors.accent.green : tokens.colors.text.disabled}
      cursor="pointer"
      transition="all 0.15s"
      opacity={copied ? 1 : 0}
      ml="auto"
      _groupHover={{ opacity: 1 }}
      _hover={{ bg: 'rgba(255, 255, 255, 0.06)', color: tokens.colors.text.secondary }}
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleCopy() }}
      aria-label={copied ? t('chat.copied') : t('chat.copy')}
    >
      {copied ? <FiCheck size={12} /> : <FiCopy size={12} />}
    </Box>
  )
}

export const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '')
    const codeString = String(children).replace(/\n$/, '')

    if (match) {
      return (
        <Box
          borderRadius="10px"
          overflow="hidden"
          my={3}
          border="1px solid rgba(255, 255, 255, 0.06)"
          bg={tokens.colors.bg.codeBlock}
        >
          <Flex
            align="center"
            justify="space-between"
            px={3}
            py="6px"
            bg="rgba(255, 255, 255, 0.03)"
            borderBottom="1px solid rgba(255, 255, 255, 0.05)"
          >
            <Text
              fontSize="11px"
              color={tokens.colors.text.disabled}
              fontFamily={tokens.fontFamily.mono}
              textTransform="lowercase"
            >
              {match[1]}
            </Text>
            <CopyButton code={codeString} />
          </Flex>
          <SyntaxHighlighter
            style={vscDarkPlus}
            language={match[1]}
            customStyle={{
              margin: 0,
              padding: '14px 16px',
              fontSize: '12.5px',
              lineHeight: '1.65',
              background: 'transparent',
              borderRadius: 0,
            }}
          >
            {codeString}
          </SyntaxHighlighter>
        </Box>
      )
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
}

function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  // Queued user inputs live exclusively in the QueuedMessagesPreview
  // strip above the prompt — they're never inserted into the transcript.
  // A user bubble in this list is, by construction, one the agent has
  // already received, so no "pending" state needs to be expressed here.
  const isSystem = message.role === 'system'
  const updateCodeBlockStatus = useChatStore(s => s.updateCodeBlockStatus)
  const toggleReasoning = useChatStore(s => s.toggleReasoning)
  const toggleReasoningBlock = useChatStore(s => s.toggleReasoningBlock)
  const [messageCopied, setMessageCopied] = useState(false)

  // Single stable handler for both reasoning surfaces (legacy message-level
  // and per-block). MessageBubble used to build a fresh inline lambda inside
  // every `.map` iteration, which forced ReasoningBlock to re-render even
  // though it's memoized. The block now echoes its `messageId` + optional
  // `blockIndex` back to us through the callback, so we can route to the
  // right reducer without per-render closures.
  const handleReasoningToggle = useCallback(
    (anchor: HTMLElement, msgId?: string, blockIdx?: number) => {
      if (!msgId) return
      toggleReasoningPreservingScroll(anchor, () => {
        if (blockIdx !== undefined) toggleReasoningBlock(msgId, blockIdx)
        else toggleReasoning(msgId)
      })
    },
    [toggleReasoning, toggleReasoningBlock],
  )

  // Pre-compute read_large_result batching directives ONCE per render so
  // the contentBlocks .map below can read them by index without an IIFE
  // or per-iteration look-ahead. Strict adjacency on text/tool boundaries;
  // reasoning between same-id reads is swallowed into the batch.
  const batchDirectives = useMemo(() => {
    if (!message.contentBlocks || message.contentBlocks.length === 0) return []
    return computeContentBlockBatches(
      message.contentBlocks,
      id => message.toolCalls?.find(t => t.id === id),
    )
  }, [message.contentBlocks, message.toolCalls])

  const fallbackToolCallGroups = useMemo(() => {
    if (!message.toolCalls || message.toolCalls.length === 0) return []
    const groups: Array<
      | { kind: 'agent_shell_session'; calls: NonNullable<ChatMessage['toolCalls']> }
      | ReturnType<typeof groupConsecutiveLargeReads>[number]
    > = []

    for (let i = 0; i < message.toolCalls.length; i++) {
      const call = message.toolCalls[i]
      if (isAgentShellTool(call.toolName)) {
        const calls = [call]
        while (i + 1 < message.toolCalls.length && isAgentShellTool(message.toolCalls[i + 1].toolName)) {
          calls.push(message.toolCalls[i + 1])
          i++
        }
        groups.push({ kind: 'agent_shell_session', calls })
        continue
      }

      const ordinaryCalls = [call]
      while (i + 1 < message.toolCalls.length && !isAgentShellTool(message.toolCalls[i + 1].toolName)) {
        ordinaryCalls.push(message.toolCalls[i + 1])
        i++
      }
      groups.push(...groupConsecutiveLargeReads(ordinaryCalls))
    }

    return groups
  }, [message.toolCalls])

  // Build plain-text representation of this assistant message for copying.
  // Walks contentBlocks IN ORDER so reasoning passes interleave with text in
  // the correct positions (matching what the user sees in the chat).
  // Falls back to the legacy `reasoningContent` flat field + `content` for
  // older messages that pre-date the block-based representation.
  const copyableText = useCallback(() => {
    const parts: string[] = []
    if (message.contentBlocks && message.contentBlocks.length > 0) {
      for (const block of message.contentBlocks) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text)
        } else if (block.type === 'reasoning' && block.text) {
          // Tag the reasoning so the consumer can tell thoughts apart from
          // user-facing text. Plain "[Reasoning]" header is consistent with
          // the legacy fallback below.
          parts.push(`[Reasoning]\n${block.text}`)
        }
      }
    } else {
      // Legacy fallback for messages that never went through the block
      // pipeline: reasoning lives on its own field, content is one string.
      if (message.reasoningContent) {
        parts.push(`[Reasoning]\n${message.reasoningContent}`)
      }
      if (message.content) {
        parts.push(message.content)
      }
    }
    return parts.join('\n\n').trim()
  }, [message])

  // Copy menu — opens a popover with two scopes so the user picks what
  // they actually want: just this reply (quote it) vs the full transcript
  // (archive it). The Download button next door covers the file-on-disk
  // case for the full session.
  const [copyMenuOpen, setCopyMenuOpen] = useState(false)
  const copyButtonRef = useRef<HTMLDivElement | null>(null)

  const handleCopyConversation = useCallback(() => {
    setCopyMenuOpen(false)
    const text = copyableText()
    if (!text) return
    navigator.clipboard.writeText(text).catch((err) => {
      console.error('[messageCopy] clipboard write failed:', err)
      useToastStore.getState().addToast('error', t('chat.copyFailed'))
    })
    setMessageCopied(true)
    setTimeout(() => setMessageCopied(false), 2000)
  }, [copyableText])

  const handleCopySession = useCallback(() => {
    setCopyMenuOpen(false)
    const session = useChatStore.getState().getActiveSession()
    if (!session) return
    navigator.clipboard.writeText(sessionToMarkdown(session)).catch((err) => {
      console.error('[sessionCopy] clipboard write failed:', err)
      useToastStore.getState().addToast('error', t('chat.exportSessionFailed'))
    })
    setMessageCopied(true)
    setTimeout(() => setMessageCopied(false), 2000)
  }, [])

  // === Session export — downloads the WHOLE conversation (not just this
  // message). Placed next to the per-message Copy because that's the natural
  // home for end-of-turn actions; the menu makes it explicit it's session-wide.
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const exportButtonRef = useRef<HTMLDivElement | null>(null)

  const handleExportSession = useCallback(async (format: 'json' | 'md') => {
    const session = useChatStore.getState().getActiveSession()
    if (!session) return
    setExportMenuOpen(false)
    const filename = defaultExportFilename(session, format)
    // Build the environment snapshot (system prompt + TMS/PLAN/TODO + skills
    // + hashtag detection) before serialising. Async and may take a second on
    // the first call (loadSkills + buildSystemPrompt both walk the project),
    // so this happens BEFORE we open the save dialog — that way the user
    // doesn't see a stale dialog while we crunch in the background. The fn
    // never throws (failures land in envSnapshot.systemPromptError).
    const envSnapshot = await buildEnvironmentSnapshot(session)
    const content = format === 'json'
      ? sessionToJson(session, { envSnapshot })
      : sessionToMarkdown(session, { envSnapshot })
    const mimeType = format === 'json' ? 'application/json' : 'text/markdown'
    try {
      const savedPath = await triggerDownload(filename, content, mimeType)
      if (savedPath) {
        useToastStore.getState().addToast(
          'success',
          `Session saved to ${savedPath.split(/[/\\]/).pop()}`,
        )
      }
    } catch (err) {
      // Surface failures so the user knows the export didn't land. Cancel is
      // a normal path (returns null without throwing) — only real fs/dialog
      // errors hit this branch.
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[sessionExport] save failed:', err)
      useToastStore.getState().addToast('error', t('chat.exportFailed').replace('{message}', msg))
    }
  }, [])

  const handleApply = useCallback(
    (block: { id: string; code: string }) => {
      navigator.clipboard.writeText(block.code).catch(() => {})
      updateCodeBlockStatus(message.id, block.id, 'applied')
    },
    [message.id, updateCodeBlockStatus]
  )

  const handleReject = useCallback(
    (block: { id: string }) => {
      updateCodeBlockStatus(message.id, block.id, 'rejected')
    },
    [message.id, updateCodeBlockStatus]
  )

  const handleCopy = useCallback((code: string) => {
    navigator.clipboard.writeText(code).catch(() => {})
  }, [])

  // System messages: compact status line or inline card
  if (isSystem) {
    // Render inline cards
    if (message.card) {
      if (message.card.type === 'plan_approval') {
        return <PlanApprovalCard messageId={message.id} card={message.card} />
      }
      if (message.card.type === 'todo_list') {
        return <TodoListCard card={message.card} />
      }
      if (message.card.type === 'credential_request') {
        return <CredentialRequestCard messageId={message.id} card={message.card} />
      }
      if (message.card.type === 'ask_user_question' && message.card.questions && message.card.requestId) {
        return (
          <AskUserQuestionCard
            messageId={message.id}
            requestId={message.card.requestId}
            projectPath={message.card.projectPath}
            status={message.card.status}
            questions={message.card.questions}
          />
        )
      }
    }

    // Compact boundary — renders via CompactSummary component which shows
    // phased progress, trigger info, token savings, and expandable summary.
    if (message.kind === 'compact_boundary') {
      const summaryText = message.content || undefined
      return (
        <CompactSummary
          metadata={message.compactMetadata ?? {
            trigger: 'auto',
            beforeTokens: message.compactBeforeTokens ?? 0,
          }}
          summaryText={summaryText}
        />
      )
    }

    // Level-driven colour: an `error` system message must read AS error,
    // not as the generic-info bullet that everything else uses. Was missing
    // before — error-level messages rendered identically to info, hiding
    // recovery hints inside the visual noise.
    const level = message.level
    const dotColor =
      level === 'error' ? tokens.colors.accent.red
      : level === 'warn' ? tokens.colors.accent.orange
      : level === 'success' ? tokens.colors.accent.green
      : tokens.colors.text.disabled
    const textColor =
      level === 'error' ? tokens.colors.accent.red
      : level === 'warn' ? tokens.colors.accent.orange
      : level === 'success' ? tokens.colors.accent.green
      : tokens.colors.text.secondary

    return (
      <Flex
        py={1.5}
        px={3}
        mb={1}
        align="flex-start"
        gap={2}
      >
        <Box w="4px" h="4px" borderRadius="full" bg={dotColor} flexShrink={0} mt="7px" />
        <Text
          fontSize="12px"
          color={textColor}
          fontFamily={tokens.fontFamily.ui}
          lineHeight="1.5"
          whiteSpace="pre-wrap"
        >
          {message.content}
        </Text>
      </Flex>
    )
  }

  return (
    <Box
      py={isUser ? 3 : 4}
      px={3}
      bg={isUser ? 'rgba(255, 255, 255, 0.02)' : 'transparent'}
      borderRadius="12px"
      mb={1}
      className="group"
      minW={0}
      overflow="hidden"
    >
      {/* Role header */}
      <Flex align="center" gap={2.5} mb={isUser ? 1.5 : 2.5}>
        {isUser ? (
          <Flex
            w="22px"
            h="22px"
            borderRadius="6px"
            bg="rgba(255, 255, 255, 0.08)"
            align="center"
            justify="center"
            flexShrink={0}
          >
            <FiUser size={11} color={tokens.colors.text.secondary} />
          </Flex>
        ) : (
          <AgentLogo size={22} glow />
        )}
        <Text
          fontSize="13px"
          fontWeight="600"
          color={tokens.colors.text.primary}
          letterSpacing="-0.01em"
        >
          {isUser ? 'You' : 'TM Code'}
        </Text>
        {isStreaming && !isUser && (
          <Box
            w="5px"
            h="5px"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            css={{
              animation: 'msgPulse 1.5s ease-in-out infinite',
              '@keyframes msgPulse': {
                '0%, 100%': { opacity: 1 },
                '50%': { opacity: 0.25 },
              },
            }}
          />
        )}
        {isUser && message.content && (
          <CopyMessageButton text={message.content} />
        )}
      </Flex>

      {/* Content area */}
      <Box pl="34px">
        {/* Minimal activity dots — only when streaming with no visible content at all */}
        {isStreaming && !isUser && !message.content && (!message.toolCalls || message.toolCalls.length === 0) && (
          <Flex gap="4px" align="center" py={2}>
            {[0, 1, 2].map(i => (
              <Box
                key={i}
                w="5px"
                h="5px"
                borderRadius="full"
                bg={tokens.colors.accent.primary}
                animation={`pulseDot 1.4s ease-in-out ${i * 0.2}s infinite`}
              />
            ))}
          </Flex>
        )}

        {/* Legacy reasoning fallback — older persisted messages have a flat
            `reasoningContent` string but no reasoning entry inside contentBlocks.
            Render those at the top exactly as before. New messages put each
            reasoning chunk into contentBlocks (rendered inline below) so a
            second reasoning pass after tool calls appears AT its real position
            in the stream rather than being collapsed back into this top block. */}
        {message.reasoningContent
          && !message.contentBlocks?.some(b => b.type === 'reasoning')
          && message.thinkingRequested !== false
          && (
            <ReasoningBlock
              content={message.reasoningContent}
              isVisible={message.isReasoningVisible || false}
              isStreaming={isStreaming === true && message.reasoningDurationMs == null}
              durationMs={message.reasoningDurationMs}
              messageId={message.id}
              onToggle={handleReasoningToggle}
            />
          )}

        {/* Interleaved content blocks — reasoning, text, tool calls in order.
            `batchDirectives` is pre-computed by useMemo above so this render
            path is a clean .map, no IIFE. Read_large_result consolidation:
            text/non-read tool boundaries break the batch; reasoning between
            same-id reads is swallowed (timeline stays honest about real
            narrative state changes, not noise). */}
        {message.contentBlocks && message.contentBlocks.length > 0 ? (
          <>
            {message.contentBlocks.map((block, idx) => {
              // Batch handling — runs before the existing block-type switch.
              const directive = batchDirectives[idx]
              if (directive?.kind === 'batch_member') return null
              if (directive?.kind === 'batch_start') {
                return <ReadOutputBatch key={`batch-${idx}`} calls={directive.calls} />
              }
              if (block.type === 'reasoning') {
                // Hide reasoning blocks when the developer didn't ask for
                // reasoning on this turn. Some BYOK reasoning models emit
                // chain-of-thought even after we send the disable param —
                // suppress at render rather than dumping the noise into
                // the chat. Legacy messages (thinkingRequested undefined)
                // render reasoning normally.
                if (message.thinkingRequested === false) return null
                // Streaming flag: only the LAST reasoning block in the message
                // can still be live. A finalized block (durationMs set) renders
                // collapsed; the active one streams as movie credits.
                const isLastBlock = idx === (message.contentBlocks?.length ?? 0) - 1
                const blockIsStreaming = isStreaming === true
                  && isLastBlock
                  && block.durationMs === undefined
                // Per-block visibility: when the block has its own isVisible
                // flag, use it; otherwise fall back to the message-level
                // flag. This breaks the "expand-one-expands-all" bug while
                // keeping older sessions (with only message-level state)
                // working as before.
                const blockIsVisible = block.isVisible !== undefined
                  ? block.isVisible
                  : (message.isReasoningVisible || false)
                return (
                  <ReasoningBlock
                    key={`reasoning-${idx}`}
                    content={block.text}
                    isVisible={blockIsVisible}
                    isStreaming={blockIsStreaming}
                    durationMs={block.durationMs}
                    messageId={message.id}
                    blockIndex={idx}
                    onToggle={handleReasoningToggle}
                  />
                )
              }
              if (block.type === 'text' && block.text) {
                // Restore paragraph breaks the model sometimes omits when
                // narrating multiple actions in one chunk ("agora.O ReportBug"
                // → "agora.\n\nO ReportBug"). Without this the chat reads as
                // an unbroken wall of text. mb={3} on every text block except
                // the very last keeps consecutive text blocks visually
                // separated even when no tool card sits between them.
                const isLastBlock = idx === (message.contentBlocks?.length ?? 0) - 1
                return (
                  <Box key={`text-${idx}`} css={markdownStyles} mb={isLastBlock ? 0 : 3}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {normalizeAssistantText(block.text)}
                    </ReactMarkdown>
                  </Box>
                )
              }
              if (block.type === 'tool_call') {
                const tc = message.toolCalls?.find(t => t.id === block.toolCallId)
                if (tc) {
                  if (isAgentShellTool(tc.toolName)) {
                    const previous = message.contentBlocks?.[idx - 1]
                    const previousCall = previous?.type === 'tool_call'
                      ? message.toolCalls?.find(t => t.id === previous.toolCallId)
                      : null
                    if (previousCall && isAgentShellTool(previousCall.toolName)) return null

                    const calls = [tc]
                    let nextIdx = idx + 1
                    while (message.contentBlocks?.[nextIdx]?.type === 'tool_call') {
                      const nextBlock = message.contentBlocks[nextIdx]
                      if (nextBlock.type !== 'tool_call') break
                      const nextCall = message.toolCalls?.find(t => t.id === nextBlock.toolCallId)
                      if (!nextCall || !isAgentShellTool(nextCall.toolName)) break
                      calls.push(nextCall)
                      nextIdx++
                    }
                    return <ShellSessionBlock key={tc.id} toolCalls={calls} mode="chat" />
                  }
                  return <ToolCallDisplayComponent key={tc.id} toolCall={tc} messageId={message.id} />
                }
              }
              return null
            })}
          </>
        ) : (
          <>
            {/* Fallback for legacy messages without contentBlocks */}
            {message.content && (
              isUser ? (
                // User bubbles render slash commands and known hashtags in
                // the brand-pink colour to match the prompt input editor.
                // ReactMarkdown is intentionally skipped here — user messages
                // are plain text + routing tokens; running them through a
                // markdown renderer would convert `*foo*` or `#word` into
                // formatted text the user never asked for. whiteSpace
                // preserves intentional line breaks in pasted content.
                <Box
                  fontSize={tokens.fontSize.lg}
                  fontFamily={tokens.fontFamily.ui}
                  color={tokens.colors.text.primary}
                  lineHeight="1.5"
                  whiteSpace="pre-wrap"
                  wordBreak="break-word"
                >
                  {renderHighlightedPrompt(message.content)}
                </Box>
              ) : (
                <Box css={markdownStyles}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {normalizeAssistantText(message.content)}
                  </ReactMarkdown>
                </Box>
              )
            )}
            {/* User-message attachments: image thumbnails + filename chips.
                Without this block, screenshots and other attached files were
                invisible in chat-mode (only cmd-mode's TerminalMessageRenderer
                had the equivalent rendering). The data was always on
                `message.attachments`; the bug was missing UI. */}
            {isUser && message.attachments && message.attachments.length > 0 && (
              <Flex gap={2} flexWrap="wrap" mt={2}>
                {message.attachments.map(att => {
                  const isImage = att.type === 'image'
                  const hasPreview = isImage && att.base64
                  return (
                    <Flex
                      key={att.id}
                      align="center"
                      gap={2}
                      pl={hasPreview ? 0 : 2}
                      pr={3}
                      py={hasPreview ? 0 : '4px'}
                      bg="rgba(255, 255, 255, 0.04)"
                      border="1px solid rgba(255, 255, 255, 0.08)"
                      borderRadius="6px"
                      maxW="280px"
                      overflow="hidden"
                    >
                      {hasPreview ? (
                        <Box w="44px" h="44px" borderRadius="5px 0 0 5px" overflow="hidden" flexShrink={0}>
                          <img
                            src={att.base64}
                            alt={att.name}
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          />
                        </Box>
                      ) : null}
                      <Text
                        fontSize="11px"
                        color={tokens.colors.text.secondary}
                        truncate
                        maxW="200px"
                        lineHeight="1.4"
                      >
                        {att.name}
                      </Text>
                    </Flex>
                  )
                })}
              </Flex>
            )}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <Box mt={message.content ? 3 : 0}>
                {fallbackToolCallGroups.map(group => {
                  if (group.kind === 'agent_shell_session') {
                    return <ShellSessionBlock key={group.calls[0].id} toolCalls={group.calls} mode="chat" />
                  }
                  return group.kind === 'large_read_batch'
                    ? <ReadOutputBatch key={group.calls[0].id} calls={group.calls} />
                    : <ToolCallDisplayComponent key={group.call.id} toolCall={group.call} messageId={message.id} />
                })}
              </Box>
            )}

            {/* Sub-agent team activity cards */}
            {message.subAgentRunIds && message.subAgentRunIds.length > 0 && (
              <SubAgentCard runIds={message.subAgentRunIds} />
            )}
          </>
        )}

        {/* Standalone code blocks */}
        {message.codeBlocks?.map(block => (
          <CodeBlockAction
            key={block.id}
            block={block}
            messageId={message.id}
            onApply={handleApply}
            onReject={handleReject}
            onCopy={handleCopy}
          />
        ))}

        {/* Copy this message + Download whole session — shown after the agent
            finishes the task. The download button serializes the active
            session (messages + tool calls + reasoning + attachments metadata)
            as JSON or Markdown via the browser's save-as dialog. */}
        {!isUser && !isSystem && !isStreaming && copyableText() && (
          <Flex mt={2} justify="flex-end" gap={1} align="center">
            {/* Copy — opens a small menu so the user picks scope:
                "Copiar conversa" → just this assistant reply
                "Copiar sessão"   → full transcript as Markdown */}
            <Box position="relative" ref={copyButtonRef}>
              <Flex
                as="button"
                align="center"
                gap={1.5}
                px={2}
                py="4px"
                borderRadius="6px"
                fontSize="11px"
                color={messageCopied ? tokens.colors.accent.green : tokens.colors.text.disabled}
                cursor="pointer"
                transition={`all ${tokens.transition.fast}`}
                _hover={{ bg: tokens.colors.bg.hoverSubtle, color: messageCopied ? tokens.colors.accent.green : tokens.colors.text.secondary }}
                onClick={() => setCopyMenuOpen(v => !v)}
                title={messageCopied ? t('chat.copied') : t('chat.copyMessage')}
                aria-label={messageCopied ? t('chat.copied') : t('chat.copyMessage')}
                aria-haspopup="menu"
                aria-expanded={copyMenuOpen}
              >
                {messageCopied ? <FiCheck size={12} /> : <FiCopy size={12} />}
                <Text fontSize="11px" fontWeight={500}>
                  {messageCopied ? t('chat.copied') : t('chat.copyMessage')}
                </Text>
              </Flex>
              {copyMenuOpen && (
                <>
                  <Box
                    position="fixed"
                    top="0"
                    left="0"
                    right="0"
                    bottom="0"
                    zIndex={10}
                    onClick={() => setCopyMenuOpen(false)}
                  />
                  <Box
                    role="menu"
                    position="absolute"
                    bottom="calc(100% + 6px)"
                    right="0"
                    zIndex={11}
                    bg={tokens.colors.bg.overlay}
                    border={`1px solid ${tokens.colors.border.default}`}
                    borderRadius="8px"
                    boxShadow="0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.02)"
                    backdropFilter="blur(8px)"
                    minW="220px"
                    overflow="hidden"
                    py="4px"
                    css={{
                      animation: 'menuFadeIn 0.12s ease-out',
                      '@keyframes menuFadeIn': {
                        from: { opacity: 0, transform: 'translateY(4px)' },
                        to: { opacity: 1, transform: 'translateY(0)' },
                      },
                    }}
                  >
                    <Flex
                      as="button"
                      role="menuitem"
                      align="center"
                      gap={2.5}
                      w="100%"
                      px={3}
                      py="8px"
                      fontSize="12.5px"
                      color={tokens.colors.text.primary}
                      cursor="pointer"
                      transition={`background ${tokens.transition.fast}`}
                      _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                      onClick={handleCopyConversation}
                      whiteSpace="nowrap"
                    >
                      <Box color={tokens.colors.text.muted} flexShrink={0}>
                        <FiCopy size={13} />
                      </Box>
                      <Text fontSize="12.5px" lineHeight="1.3">
                        {t('chat.copyConversation')}
                      </Text>
                    </Flex>
                    <Flex
                      as="button"
                      role="menuitem"
                      align="center"
                      gap={2.5}
                      w="100%"
                      px={3}
                      py="8px"
                      fontSize="12.5px"
                      color={tokens.colors.text.primary}
                      cursor="pointer"
                      transition={`background ${tokens.transition.fast}`}
                      _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                      onClick={handleCopySession}
                      whiteSpace="nowrap"
                    >
                      <Box color={tokens.colors.text.muted} flexShrink={0}>
                        <FiFileText size={13} />
                      </Box>
                      <Text fontSize="12.5px" lineHeight="1.3">
                        {t('chat.copySession')}
                      </Text>
                    </Flex>
                  </Box>
                </>
              )}
            </Box>

            {/* Download session — opens a small menu with JSON / Markdown */}
            <Box position="relative" ref={exportButtonRef}>
              <Flex
                as="button"
                align="center"
                gap={1.5}
                px={2}
                py="4px"
                borderRadius="6px"
                fontSize="11px"
                color={tokens.colors.text.disabled}
                cursor="pointer"
                transition={`all ${tokens.transition.fast}`}
                _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.secondary }}
                onClick={() => setExportMenuOpen(v => !v)}
                title={t('chat.downloadSession')}
                aria-label={t('chat.downloadSession')}
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
              >
                <FiDownload size={12} />
                <Text fontSize="11px" fontWeight={500}>
                  {t('chat.downloadSession')}
                </Text>
              </Flex>
              {exportMenuOpen && (
                <>
                  {/* Click-outside catcher */}
                  <Box
                    position="fixed"
                    top="0"
                    left="0"
                    right="0"
                    bottom="0"
                    zIndex={10}
                    onClick={() => setExportMenuOpen(false)}
                  />
                  <Box
                    role="menu"
                    position="absolute"
                    bottom="calc(100% + 6px)"
                    right="0"
                    zIndex={11}
                    bg={tokens.colors.bg.overlay}
                    border={`1px solid ${tokens.colors.border.default}`}
                    borderRadius="8px"
                    boxShadow="0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.02)"
                    backdropFilter="blur(8px)"
                    minW="220px"
                    overflow="hidden"
                    py="4px"
                    css={{
                      animation: 'menuFadeIn 0.12s ease-out',
                      '@keyframes menuFadeIn': {
                        from: { opacity: 0, transform: 'translateY(4px)' },
                        to: { opacity: 1, transform: 'translateY(0)' },
                      },
                    }}
                  >
                    <Text
                      px={3}
                      pt="6px"
                      pb="4px"
                      fontSize="10px"
                      fontWeight="600"
                      letterSpacing="0.06em"
                      textTransform="uppercase"
                      color={tokens.colors.text.disabled}
                    >
                      {t('chat.downloadSession')}
                    </Text>
                    <Flex
                      as="button"
                      role="menuitem"
                      align="center"
                      gap={2.5}
                      w="100%"
                      px={3}
                      py="8px"
                      fontSize="12.5px"
                      color={tokens.colors.text.primary}
                      cursor="pointer"
                      transition={`background ${tokens.transition.fast}`}
                      _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                      onClick={() => handleExportSession('json')}
                      whiteSpace="nowrap"
                    >
                      <Box color={tokens.colors.text.muted} flexShrink={0}>
                        <FiCode size={13} />
                      </Box>
                      <Text fontSize="12.5px" lineHeight="1.3">
                        {t('chat.downloadJson')}
                      </Text>
                    </Flex>
                    <Flex
                      as="button"
                      role="menuitem"
                      align="center"
                      gap={2.5}
                      w="100%"
                      px={3}
                      py="8px"
                      fontSize="12.5px"
                      color={tokens.colors.text.primary}
                      cursor="pointer"
                      transition={`background ${tokens.transition.fast}`}
                      _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                      onClick={() => handleExportSession('md')}
                      whiteSpace="nowrap"
                    >
                      <Box color={tokens.colors.text.muted} flexShrink={0}>
                        <FiFileText size={13} />
                      </Box>
                      <Text fontSize="12.5px" lineHeight="1.3">
                        {t('chat.downloadMarkdown')}
                      </Text>
                    </Flex>
                  </Box>
                </>
              )}
            </Box>
          </Flex>
        )}

        {/* Activity indicator — shown during tool execution */}
        {isStreaming && !isUser && message.toolCalls?.some(tc => tc.status === 'running') && (
          <Flex align="center" gap={2} py={2} mt={2}>
            <Flex gap="4px" align="center">
              {[0, 1, 2].map(i => (
                <Box
                  key={i}
                  w="6px"
                  h="6px"
                  borderRadius="full"
                  bg={tokens.colors.accent.primary}
                  css={{
                    animation: `activityPulse 1.4s ease-in-out ${i * 0.2}s infinite`,
                    '@keyframes activityPulse': {
                      '0%, 80%, 100%': { opacity: 0.15, transform: 'scale(0.7)' },
                      '40%': { opacity: 1, transform: 'scale(1)' },
                    },
                  }}
                />
              ))}
            </Flex>
          </Flex>
        )}
      </Box>
    </Box>
  )
}

export default memo(MessageBubble, (prev, next) => {
  // Always re-render the streaming message (content is mutated in place)
  if (next.isStreaming) return false
  // Otherwise, skip re-render if props are the same
  return prev.message === next.message && prev.isStreaming === next.isStreaming
})
