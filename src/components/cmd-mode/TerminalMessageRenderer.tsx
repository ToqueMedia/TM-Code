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
import { renderHighlightedPrompt } from '../prompt/promptHighlight'

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
        requestId={card.requestId}
        questions={card.questions}
      />
    )
  }

  return null
}

// ─── ContentBlocksRenderer ───

function ContentBlocksRenderer({
  blocks,
  toolCalls,
}: {
  blocks: ContentBlock[]
  toolCalls?: ToolCallDisplay[]
}) {
  const toolCallMap = useMemo(
    () => new Map(toolCalls?.map(tc => [tc.id, tc]) || []),
    [toolCalls],
  )

  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'text') {
          return (
            <Box
              key={`text-${i}`}
              mb={1}
              fontSize="14px"
              color={tokens.colors.terminal.foreground}
              lineHeight="1.55"
              css={{ '& > span:last-child': { marginBottom: 0 } }}
            >
              <ReactMarkdown components={terminalMarkdownComponents}>{block.text}</ReactMarkdown>
            </Box>
          )
        }
        if (block.type === 'tool_call') {
          const tc = toolCallMap.get(block.toolCallId)
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
      <Box mb={4}>
        <Flex gap={1.5} align="flex-start">
          <Text
            fontFamily={tokens.fontFamily.mono}
            fontSize="14px"
            color={tokens.colors.accent.purple}
            fontWeight="700"
            lineHeight="1.55"
            flexShrink={0}
            userSelect="none"
          >
            ❯
          </Text>
          <Box flex="1">
            <Text
              fontSize="14px"
              color="#ffffff"
              whiteSpace="pre-wrap"
              lineHeight="1.55"
              fontWeight="500"
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
    const text = message.content || ''
    const level = message.level

    const color =
      level === 'error' ? tokens.colors.accent.red
      : level === 'success' ? tokens.colors.terminal.green
      : level === 'warn' ? tokens.colors.accent.orange
      : tokens.colors.text.muted

    const prefix = level === 'error' ? '✗' : level === 'success' ? '✓' : '◇'

    return (
      <Box mb={3} py="2px">
        <Flex gap={1.5} align="flex-start">
          <Text fontSize="12px" color={color} fontFamily={tokens.fontFamily.mono} flexShrink={0} lineHeight="1.55" userSelect="none">
            {prefix}
          </Text>
          <Text fontSize="13px" color={color} fontFamily={tokens.fontFamily.mono} whiteSpace="pre-wrap" lineHeight="1.55" opacity={0.9}>
            {text}
          </Text>
        </Flex>
      </Box>
    )
  }

  // ── Assistant message ──
  const hasContentBlocks = message.contentBlocks && message.contentBlocks.length > 0

  return (
    <Box mb={4}>
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

      {/* Reasoning block — live streaming with film-credits effect, same as chat mode */}
      {message.reasoningContent && (
        <TerminalReasoningBlock
          content={message.reasoningContent}
          isStreaming={!!isStreaming}
          durationMs={message.reasoningDurationMs}
        />
      )}

      {/* Special cards (credential requests, etc.) */}
      <TerminalSpecialCards message={message} />

      {/* Content */}
      {hasContentBlocks ? (
        // Content blocks already contain all text + tool call refs — don't also render message.content
        <ContentBlocksRenderer blocks={message.contentBlocks!} toolCalls={message.toolCalls} />
      ) : (
        <>
          {message.toolCalls?.map(tc => <TerminalToolCall key={tc.id} toolCall={tc} />)}
          {message.content && (
            <Box
              mb={1}
              fontSize="14px"
              color={tokens.colors.terminal.foreground}
              lineHeight="1.55"
              css={{ '& > span:last-child': { marginBottom: 0 } }}
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
        >
          <Text
            fontSize="12px"
            color={tokens.colors.text.muted}
            fontFamily={tokens.fontFamily.mono}
            lineHeight="1.6"
            whiteSpace="pre-wrap"
            fontStyle="italic"
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
