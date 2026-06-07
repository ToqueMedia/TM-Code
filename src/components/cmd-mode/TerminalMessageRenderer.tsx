import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import ReactMarkdown from 'react-markdown'
import { FiFile, FiFolder, FiImage } from 'react-icons/fi'
import type { ChatMessage, ContentBlock, ToolCallDisplay, Attachment } from '../../types/chat'
import { tokens } from '@/theme/tokens'
import { terminalMarkdownComponents } from './terminalHelpers'
import { TerminalToolCall } from './TerminalToolCall'
import { TerminalCodeBlock } from './TerminalCodeBlock'
import { TerminalCredentialPrompt } from './TerminalCredentialPrompt'
import { TerminalAskUserQuestion } from './TerminalAskUserQuestion'
import { TerminalPlanApprovalCard } from './TerminalPlanApprovalCard'
import SubAgentCard from '../chat/SubAgentCard'
import { renderHighlightedPrompt } from '../prompt/promptHighlight'
import { useChatStore } from '../../stores/chatStore'
import { groupConsecutiveAgentShellCalls, isAgentShellTool, ShellCommandBlock, ShellSessionBlock } from '../shell/ShellCommandBlock'

const USER_PROMPT_COLOR = tokens.colors.accent.purple
const USER_TEXT_COLOR = '#f2ecff'
const ASSISTANT_MARKER_COLOR = tokens.colors.terminal.cyan
const ASSISTANT_TEXT_COLOR = '#b9c7d9'

// ─── Special card renderer (plan_approval, credential_request, ask_user_question) ───

function TerminalSpecialCards({ message }: { message: ChatMessage }) {
  const card = message.card
  if (!card) return null

  if (card.type === 'plan_approval') {
    return (
      <TerminalPlanApprovalCard
        key={message.id}
        messageId={message.id}
        card={card}
      />
    )
  }

  if (card.type === 'credential_request') {
    return (
      <TerminalCredentialPrompt
        key={message.id}
        messageId={message.id}
        card={card}
      />
    )
  }

  if (card.type === 'ask_user_question' && card.questions && card.requestId) {
    return (
      <TerminalAskUserQuestion
        key={message.id}
        messageId={message.id}
        requestId={card.requestId}
        questions={card.questions}
        status={card.status}
      />
    )
  }

  return null
}

// ─── ContentBlocksRenderer ───

function ContentBlocksRenderer({
  blocks,
  toolCalls,
  isStreaming,
}: {
  blocks: ContentBlock[]
  toolCalls?: ToolCallDisplay[]
  isStreaming?: boolean
}) {
  const streamingVersion = useChatStore(s => s.streamingVersion)

  const toolCallMap = useMemo(
    () => new Map(toolCalls?.map(tc => [tc.id, tc]) || []),
    [toolCalls],
  )

  // When streaming, find the last in-flight reasoning block (no durationMs).
  // All text/tool_call blocks that come AFTER it should be hidden to prevent
  // narration from appearing while thinking is still in progress (race condition).
  const activeReasoningIdx = useMemo(() => {
    if (!isStreaming) return -1
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b.type === 'reasoning' && b.durationMs === undefined && b.startedAt) {
        return i
      }
    }
    return -1
  }, [blocks, isStreaming, streamingVersion])

  // Preprocess blocks to:
  // 1. Hide trivial reasoning blocks (durationMs < 150ms or empty text).
  // 2. Coalesce adjacent/consecutive text blocks to heal split words and sentences (no line breaks).
  // 3. Hide any blocks after an active in-flight reasoning block during streaming.
  const optimizedBlocks = useMemo(() => {
    const result: ContentBlock[] = []

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]

      // Hide text/tool_call blocks after an in-flight reasoning block during streaming.
      if (activeReasoningIdx !== -1 && i > activeReasoningIdx) {
        continue
      }

      if (block.type === 'reasoning') {
        const isActiveStreaming = isStreaming && block.durationMs === undefined
        const isTrivial = (
          (!isActiveStreaming && block.durationMs !== undefined && block.durationMs < 150) ||
          !block.text.trim()
        )
        if (isTrivial) {
          continue
        }
      }

      if (block.type === 'text') {
        const last = result[result.length - 1]
        if (last && last.type === 'text') {
          // Merge adjacent text blocks to heal split words/sentences
          result[result.length - 1] = {
            ...last,
            text: last.text + block.text,
          }
          continue
        }
      }

      result.push({ ...block })
    }

    return result
  }, [blocks, activeReasoningIdx, isStreaming, streamingVersion])

  return (
    <>
      {optimizedBlocks.map((block, i) => {
        if (block.type === 'reasoning') {
          return (
            <TerminalReasoningBlock
              key={`reasoning-${i}`}
              content={block.text}
              isStreaming={!!isStreaming && block.durationMs === undefined}
              durationMs={block.durationMs}
            />
          )
        }
        if (block.type === 'text') {
          return (
            <Box
              key={`text-${i}`}
              mb={1}
              fontSize="14px"
              color={ASSISTANT_TEXT_COLOR}
              lineHeight="1.55"
              css={{ '& > span:last-child': { marginBottom: 0 } }}
              maxW="100%"
              wordBreak="break-word"
              overflowWrap="anywhere"
            >
              <ReactMarkdown components={terminalMarkdownComponents}>{block.text}</ReactMarkdown>
            </Box>
          )
        }
        if (block.type === 'tool_call') {
          const tc = toolCallMap.get(block.toolCallId)
          if (tc && isAgentShellTool(tc.toolName)) {
            const previous = optimizedBlocks[i - 1]
            const previousCall = previous?.type === 'tool_call' ? toolCallMap.get(previous.toolCallId) : null
            if (previousCall && isAgentShellTool(previousCall.toolName)) return null

            const calls = [tc]
            let nextIdx = i + 1
            while (optimizedBlocks[nextIdx]?.type === 'tool_call') {
              const nextBlock = optimizedBlocks[nextIdx]
              if (nextBlock.type !== 'tool_call') break
              const nextCall = toolCallMap.get(nextBlock.toolCallId)
              if (!nextCall || !isAgentShellTool(nextCall.toolName)) break
              calls.push(nextCall)
              nextIdx++
            }
            return <ShellSessionBlock key={block.toolCallId} toolCalls={calls} mode="terminal" />
          }
          return tc ? <TerminalToolCall key={block.toolCallId} toolCall={tc} /> : null
        }
        return null
      })}
    </>
  )
}

// ─── UserMessageAttachments — inline thumbnails for terminal output ───

const attachmentIcons = {
  file: FiFile,
  folder: FiFolder,
  image: FiImage,
}

function UserMessageAttachments({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null

  return (
    <Flex gap={2} flexWrap="wrap" mt={1.5} ml={4}>
      {attachments.map(att => {
        const Icon = attachmentIcons[att.type]
        const isImage = att.type === 'image'

        return (
          <Flex
            key={att.id}
            align="center"
            gap={1.5}
            pl={isImage && att.base64 ? 0 : 1.5}
            pr={2}
            py={isImage && att.base64 ? 0 : '2px'}
            bg="rgba(255, 255, 255, 0.03)"
            border="1px solid rgba(255, 255, 255, 0.06)"
            borderRadius="5px"
            maxW="200px"
            overflow="hidden"
          >
            {isImage && att.base64 ? (
              <Box
                w="28px"
                h="28px"
                borderRadius="4px 0 0 4px"
                overflow="hidden"
                flexShrink={0}
              >
                <img
                  src={att.base64}
                  alt={att.name}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              </Box>
            ) : (
              <Icon size={11} color={tokens.colors.text.muted} style={{ flexShrink: 0 }} />
            )}
            <Text
              fontSize="10px"
              fontFamily={tokens.fontFamily.mono}
              color={tokens.colors.text.muted}
              truncate
              maxW="140px"
              lineHeight="1.3"
            >
              {att.name}
            </Text>
          </Flex>
        )
      })}
    </Flex>
  )
}

// ─── TerminalMessageRenderer ───

interface TerminalMessageRendererProps {
  message: ChatMessage
  isStreaming?: boolean
}

function TerminalMessageRendererInner({
  message,
  isStreaming,
}: TerminalMessageRendererProps) {
  // ── User message ──
  if (message.role === 'user') {
    const hasAttachments = message.attachments && message.attachments.length > 0

    return (
      <Box
        mb={4}
        py={1.5}
        pl={2}
        pr={2}
        borderLeft={`2px solid ${USER_PROMPT_COLOR}`}
        bg="rgba(163, 113, 247, 0.035)"
        borderRadius="0 4px 4px 0"
      >
        <Flex gap={1.5} align="flex-start">
          <Text
            fontFamily={tokens.fontFamily.mono}
            fontSize="14px"
            color={USER_PROMPT_COLOR}
            fontWeight="700"
            lineHeight="1.55"
            flexShrink={0}
            userSelect="none"
          >
            ❯
          </Text>
          <Box flex="1" minW={0}>
            <Text
              fontSize="14px"
              color={USER_TEXT_COLOR}
              whiteSpace="pre-wrap"
              lineHeight="1.55"
              fontWeight="600"
              wordBreak="break-word"
              overflowWrap="anywhere"
            >
              {renderHighlightedPrompt(message.content)}
            </Text>
            {hasAttachments && (
              <UserMessageAttachments attachments={message.attachments!} />
            )}
          </Box>
        </Flex>
      </Box>
    )
  }

  // ── System message ──
  if (message.role === 'system') {
    if (message.terminalCommand) {
      return (
        <ShellCommandBlock
          mode="terminal"
          toolCall={{
            id: message.id,
            toolName: 'execute_command',
            input: { command: message.terminalCommand.command },
            result: `${message.terminalCommand.output}${message.terminalCommand.output ? '\n' : ''}Exit code: ${message.terminalCommand.exitCode}`,
            isError: message.terminalCommand.exitCode !== 0,
            status: message.terminalCommand.exitCode === 0 ? 'completed' : 'failed',
            timestamp: message.timestamp,
          }}
        />
      )
    }

    // Cards (ask_user_question, plan_approval, credential_request) are system
    // messages with card data — render them via TerminalSpecialCards instead of
    // plain text.
    if (message.card) {
      return (
        <Box mb={3} py="2px" pl="6px">
          <TerminalSpecialCards message={message} />
        </Box>
      )
    }

    const text = message.content || ''
    const level = message.level

    const color =
      level === 'error' ? tokens.colors.accent.red
      : level === 'success' ? tokens.colors.terminal.green
      : level === 'warn' ? tokens.colors.accent.orange
      : tokens.colors.text.muted

    const prefix = level === 'error' ? '✗' : level === 'success' ? '✓' : '◇'

    return (
      <Box mb={3} py="2px" maxW="100%">
        <Flex gap={1.5} align="flex-start" maxW="100%">
          <Text fontSize="12px" color={color} fontFamily={tokens.fontFamily.mono} flexShrink={0} lineHeight="1.55" userSelect="none">
            {prefix}
          </Text>
          <Text
            fontSize="13px"
            color={color}
            fontFamily={tokens.fontFamily.mono}
            whiteSpace="pre-wrap"
            lineHeight="1.55"
            opacity={0.9}
            wordBreak="break-word"
            overflowWrap="anywhere"
            flex="1"
            minW={0}
          >
            {text}
          </Text>
        </Flex>
      </Box>
    )
  }

  // ── Assistant message ──
  const hasContentBlocks = message.contentBlocks && message.contentBlocks.length > 0

  return (
    <Box
      mb={4}
      maxW="100%"
      overflowX="hidden"
      wordBreak="break-word"
      style={{ overflowWrap: 'anywhere' }}
      borderLeft={`2px solid rgba(17, 168, 205, 0.28)`}
      pl={2.5}
    >
      <Flex align="center" gap={1.5} mb={message.content || hasContentBlocks || message.toolCalls?.length ? 1 : 0}>
        <Text
          fontFamily={tokens.fontFamily.mono}
          fontSize="12px"
          color={ASSISTANT_MARKER_COLOR}
          lineHeight="1.4"
          userSelect="none"
        >
          ◆
        </Text>
        <Text
          fontFamily={tokens.fontFamily.mono}
          fontSize="10px"
          color={tokens.colors.text.disabled}
          lineHeight="1.4"
          textTransform="uppercase"
          letterSpacing="0"
          userSelect="none"
        >
          TM Code
        </Text>
      </Flex>
      {/* Waiting dots — only when streaming with no visible content yet */}
      {isStreaming && !message.content && (!message.toolCalls || message.toolCalls.length === 0) && (
        <Flex gap="5px" align="center" py={1.5}>
          {[0, 1, 2].map(i => (
            <Box
              key={i}
              w="4px"
              h="4px"
              borderRadius="full"
              bg={tokens.colors.accent.purple}
              css={{
                animation: `pulseDot 1.4s ease-in-out ${i * 0.2}s infinite`,
                '@keyframes pulseDot': {
                  '0%, 80%, 100%': { opacity: 0.15, transform: 'scale(0.7)' },
                  '40%': { opacity: 1, transform: 'scale(1)' },
                },
              }}
            />
          ))}
        </Flex>
      )}

      {/* Legacy reasoning fallback — older persisted messages have a flat
          `reasoningContent` string but no reasoning entry inside contentBlocks.
          Render those at the top exactly as before. New messages put each
          reasoning chunk into contentBlocks (rendered inline by ContentBlocksRenderer)
          so reasoning appears AT its real position in the stream rather than being
          collapsed back into this top block. */}
      {message.reasoningContent
        && !message.contentBlocks?.some(b => b.type === 'reasoning')
        && message.thinkingRequested !== false
        && (
        <TerminalReasoningBlock
          content={message.reasoningContent}
          isStreaming={!!isStreaming}
          durationMs={message.reasoningDurationMs}
        />
      )}

      {/* Special cards (credential requests, etc.) */}
      <TerminalSpecialCards message={message} />

      {/* Sub-agent team activity cards */}
      {message.subAgentRunIds && message.subAgentRunIds.length > 0 && (
        <SubAgentCard runIds={message.subAgentRunIds} />
      )}

      {/* Content — hide text/narration while reasoning is in-flight to prevent race */}
      {hasContentBlocks ? (
        // Content blocks already contain all text + tool call refs — don't also render message.content
        <ContentBlocksRenderer blocks={message.contentBlocks!} toolCalls={message.toolCalls} isStreaming={isStreaming} />
      ) : (
        <>
          {message.toolCalls && groupConsecutiveAgentShellCalls(message.toolCalls).map(group => (
            group.kind === 'agent_shell_session'
              ? <ShellSessionBlock key={group.calls[0].id} toolCalls={group.calls} mode="terminal" />
              : <TerminalToolCall key={group.call.id} toolCall={group.call} />
          ))}
          {/* Hide text content while reasoning is in-flight */}
          {!(isStreaming && message.reasoningContent && !message.reasoningDurationMs) && message.content && (
            <Box
              mb={1}
              fontSize="14px"
              color={ASSISTANT_TEXT_COLOR}
              lineHeight="1.55"
              css={{ '& > span:last-child': { marginBottom: 0 } }}
              maxW="100%"
              wordBreak="break-word"
              overflowWrap="anywhere"
            >
              <ReactMarkdown components={terminalMarkdownComponents}>{message.content}</ReactMarkdown>
            </Box>
          )}
          {message.codeBlocks?.map(b => <TerminalCodeBlock key={b.id} block={b} />)}
        </>
      )}

      {/* Blinking cursor during streaming */}
      {isStreaming && (
        <Box
          display="inline-block"
          w="7px"
          h="13px"
          bg={tokens.colors.accent.purple}
          ml="1px"
          verticalAlign="middle"
          css={{
            animation: 'blink 1s step-end infinite',
            '@keyframes blink': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0 } },
          }}
        />
      )}

      {/* Per-turn footer — duration + tokens, captured at finalize time. */}
      {!isStreaming && (message.turnDurationMs !== undefined || message.turnInputTokens || message.turnOutputTokens) && (
        <Flex align="center" gap={2} mt={1.5} opacity={0.6}>
          {message.turnDurationMs !== undefined && (
            <Text fontSize="11px" color={tokens.colors.accent.green} fontFamily={tokens.fontFamily.mono}>
              ✓ {formatTurnDuration(message.turnDurationMs)}
            </Text>
          )}
          {message.turnInputTokens ? (
            <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
              ↑ {formatTurnTokens(message.turnInputTokens)}
            </Text>
          ) : null}
          {message.turnOutputTokens ? (
            <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
              ↓ {formatTurnTokens(message.turnOutputTokens)}
            </Text>
          ) : null}
        </Flex>
      )}
    </Box>
  )
}

// ─── TerminalReasoningBlock ────────────────────────────────────────────────
// Live reasoning with film-credits effect during streaming, collapsible after.
// Same UX as chat-mode ReasoningBlock but styled for the terminal aesthetic.

const CREDITS_HEIGHT_PX = 140

function TerminalReasoningBlock({ content, isStreaming, durationMs }: {
  content: string
  isStreaming: boolean
  durationMs?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const userScrolledRef = useRef(false)

  // Auto-scroll: credits-roll effect — stick to bottom while content grows.
  useEffect(() => {
    const node = scrollRef.current
    if (!node || userScrolledRef.current) return
    node.scrollTop = node.scrollHeight
  }, [content])

  function handleScroll(e: React.UIEvent<HTMLDivElement>): void {
    const node = e.currentTarget
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop
    userScrolledRef.current = distanceFromBottom > 12
  }

  // Reset scroll tracking when streaming starts
  useEffect(() => {
    if (isStreaming) userScrolledRef.current = false
  }, [isStreaming])

  const isExpanded = isStreaming || expanded

  // Duration label
  const durationLabel = useMemo(() => {
    if (durationMs == null) return null
    const s = durationMs / 1000
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
    const m = Math.floor(s / 60)
    const rs = Math.round(s - m * 60)
    return `${m}m ${rs}s`
  }, [durationMs])

  if (!content) return null

  return (
    <Box mb={1.5}>
      {/* Header — clickable to expand/collapse after streaming */}
      <Flex
        align="center"
        gap={1.5}
        cursor={isStreaming ? 'default' : 'pointer'}
        onClick={() => { if (!isStreaming) setExpanded(e => !e) }}
        py="3px"
        px="6px"
        borderRadius="4px"
        _hover={isStreaming ? undefined : { bg: 'rgba(255, 255, 255, 0.03)' }}
        userSelect="none"
      >
        {isStreaming ? (
          <Flex gap="4px" align="center">
            <Flex gap="2px" align="center">
              {[0, 1, 2].map(i => (
                <Box
                  key={i}
                  w="3px"
                  h="3px"
                  borderRadius="full"
                  bg={tokens.colors.accent.purple}
                  css={{
                    animation: `terminalPulse 1.4s ease-in-out ${i * 0.2}s infinite`,
                    '@keyframes terminalPulse': {
                      '0%, 80%, 100%': { opacity: 0.15, transform: 'scale(0.7)' },
                      '40%': { opacity: 1, transform: 'scale(1)' },
                    },
                  }}
                />
              ))}
            </Flex>
            <Text fontSize="10px" color={tokens.colors.accent.purple} fontFamily={tokens.fontFamily.mono} fontWeight="600" letterSpacing="0.05em">
              THINKING
            </Text>
          </Flex>
        ) : (
          <Flex align="center" gap={1.5}>
            <Text fontSize="11px" color={tokens.colors.text.disabled}>
              {isExpanded ? '▾' : '▸'}
            </Text>
            <Text fontSize="10px" color={tokens.colors.accent.purple} fontFamily={tokens.fontFamily.mono} fontWeight="600" letterSpacing="0.05em">
              THINKING
            </Text>
            {durationLabel && (
              <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
                {durationLabel}
              </Text>
            )}
          </Flex>
        )}
      </Flex>

      {/* Content — fixed height + credits effect during streaming, auto after */}
      {isExpanded && (
        <Box
          ref={scrollRef}
          onScroll={handleScroll}
          ml="6px"
          pl={2}
          borderLeft={`2px solid ${tokens.colors.accent.purpleMuted}`}
          height={isStreaming ? `${CREDITS_HEIGHT_PX}px` : 'auto'}
          maxH={isStreaming ? `${CREDITS_HEIGHT_PX}px` : '240px'}
          overflowY="auto"
          py="6px"
          px="8px"
          css={{
            '&::-webkit-scrollbar': { width: '3px' },
            '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.08)', borderRadius: '2px' },
            ...(isStreaming ? {
              maskImage: 'linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)',
            } : {}),
          }}
          display={isStreaming ? 'flex' : 'block'}
          flexDirection={isStreaming ? 'column' : undefined}
          justifyContent={isStreaming ? 'flex-end' : undefined}
          maxW="100%"
        >
          <Text
            fontSize="12px"
            color={tokens.colors.text.muted}
            fontFamily={tokens.fontFamily.mono}
            lineHeight="1.6"
            whiteSpace="pre-wrap"
            fontStyle="italic"
            wordBreak="break-word"
            overflowWrap="anywhere"
          >
            {content}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function formatTurnDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  return `${m}m ${rs}s`
}

function formatTurnTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// Custom comparator: always re-render the streaming message.
// appendTextDelta mutates message.content in-place (same object reference),
// so default memo would skip re-renders during streaming and nothing would appear.
export const TerminalMessageRenderer = memo(
  TerminalMessageRendererInner,
  (prev, next) => {
    if (next.isStreaming) return false  // force re-render while content arrives
    return prev.message === next.message && prev.isStreaming === next.isStreaming
  },
)
