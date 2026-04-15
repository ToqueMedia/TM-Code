import { memo, useMemo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import ReactMarkdown from 'react-markdown'
import type { ChatMessage, ContentBlock, ToolCallDisplay } from '../../types/chat'
import { tokens } from '@/theme/tokens'
import { terminalMarkdownComponents } from './terminalHelpers'
import { TerminalToolCall } from './TerminalToolCall'
import { TerminalCodeBlock } from './TerminalCodeBlock'

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
            <Box key={`text-${i}`} mb={1}>
              <Text fontSize="13px" color={tokens.colors.terminal.foreground} lineHeight="1.5">
                <ReactMarkdown components={terminalMarkdownComponents}>{block.text}</ReactMarkdown>
              </Text>
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
    return (
      <Box mb={4}>
        <Flex gap={1.5} align="flex-start">
          <Text
            fontFamily={tokens.fontFamily.mono}
            fontSize="13px"
            color={tokens.colors.accent.purple}
            fontWeight="700"
            lineHeight="1.5"
            flexShrink={0}
            userSelect="none"
          >
            ❯
          </Text>
          <Text
            fontSize="13px"
            color="#ffffff"
            whiteSpace="pre-wrap"
            lineHeight="1.5"
            flex="1"
            fontWeight="500"
          >
            {message.content}
          </Text>
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
          <Text fontSize="11px" color={color} fontFamily={tokens.fontFamily.mono} flexShrink={0} lineHeight="1.5" userSelect="none">
            {prefix}
          </Text>
          <Text fontSize="12px" color={color} fontFamily={tokens.fontFamily.mono} whiteSpace="pre-wrap" lineHeight="1.5" opacity={0.85}>
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

      {/* Reasoning block — collapsed during streaming, shown after */}
      {message.reasoningContent && !isStreaming && (
        <Box mb={1.5} pl={2} borderLeft={`2px solid ${tokens.colors.accent.purpleMuted}`}>
          <Text fontSize="10px" color={tokens.colors.accent.purple} fontWeight="700" mb="3px" fontFamily={tokens.fontFamily.mono} letterSpacing="0.06em">
            THINKING
          </Text>
          <Text fontSize="11px" color={tokens.colors.text.secondary} whiteSpace="pre-wrap" lineHeight="1.5">
            {message.reasoningContent}
          </Text>
        </Box>
      )}

      {/* Content */}
      {hasContentBlocks ? (
        // Content blocks already contain all text + tool call refs — don't also render message.content
        <ContentBlocksRenderer blocks={message.contentBlocks!} toolCalls={message.toolCalls} />
      ) : (
        <>
          {message.toolCalls?.map(tc => <TerminalToolCall key={tc.id} toolCall={tc} />)}
          {message.content && (
            <Box mb={1}>
              <Text fontSize="13px" color={tokens.colors.terminal.foreground} lineHeight="1.5">
                <ReactMarkdown components={terminalMarkdownComponents}>{message.content}</ReactMarkdown>
              </Text>
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
    </Box>
  )
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
