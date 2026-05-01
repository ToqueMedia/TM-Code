import { memo, useCallback, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiUser, FiCopy, FiCheck, FiDownload, FiCode, FiFileText } from 'react-icons/fi'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { ChatMessage } from '../../types/chat'
import { useChatStore } from '../../stores/chatStore'
import CodeBlockAction from './CodeBlockAction'
import ToolCallDisplayComponent from './ToolCallDisplay'
import AgentLogo from '../ui/AgentLogo'
import ReasoningBlock from './ReasoningBlock'
import PlanApprovalCard from './PlanApprovalCard'
import TodoListCard from './TodoListCard'
import CredentialRequestCard from './CredentialRequestCard'
import {
  sessionToJson,
  sessionToMarkdown,
  triggerDownload,
  defaultExportFilename,
} from '../../utils/sessionExport'
import { useToastStore } from '../../stores/toastStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

interface MessageBubbleProps {
  message: ChatMessage
  isStreaming?: boolean
}

const markdownStyles = {
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

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
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
  const isSystem = message.role === 'system'
  const updateCodeBlockStatus = useChatStore(s => s.updateCodeBlockStatus)
  const toggleReasoning = useChatStore(s => s.toggleReasoning)
  const [messageCopied, setMessageCopied] = useState(false)

  // Build plain-text representation of this assistant message for copying.
  // Combines contentBlocks (text + tool call summaries) and fallback content.
  const copyableText = useCallback(() => {
    const parts: string[] = []
    if (message.reasoningContent) {
      parts.push(`[Reasoning]\n${message.reasoningContent}`)
    }
    if (message.contentBlocks && message.contentBlocks.length > 0) {
      for (const block of message.contentBlocks) {
        if (block.type === 'text' && block.text) parts.push(block.text)
      }
    } else if (message.content) {
      parts.push(message.content)
    }
    return parts.join('\n\n').trim()
  }, [message])

  // Copy the WHOLE session (messages + tool calls + reasoning) to clipboard
  // as Markdown. The button lives on each assistant message but the action
  // is session-wide — mirrors the Download button next to it and matches the
  // user's request to capture the full transcript including tool activity.
  const handleCopyMessage = useCallback(() => {
    const session = useChatStore.getState().getActiveSession()
    if (!session) {
      // Fallback: copy just this message's text if there's no active session.
      const text = copyableText()
      if (!text) return
      navigator.clipboard.writeText(text).catch(() => {})
    } else {
      navigator.clipboard.writeText(sessionToMarkdown(session)).catch((err) => {
        console.error('[sessionCopy] clipboard write failed:', err)
        useToastStore.getState().addToast('error', 'Could not copy session to clipboard')
      })
    }
    setMessageCopied(true)
    setTimeout(() => setMessageCopied(false), 2000)
  }, [copyableText])

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
    const content = format === 'json' ? sessionToJson(session) : sessionToMarkdown(session)
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
      useToastStore.getState().addToast('error', `Export failed: ${msg}`)
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
    }

    return (
      <Flex
        py={1.5}
        px={3}
        mb={1}
        align="center"
        gap={2}
      >
        <Box w="4px" h="4px" borderRadius="full" bg={tokens.colors.text.disabled} flexShrink={0} />
        <Text
          fontSize="12px"
          color={tokens.colors.text.secondary}
          fontFamily={tokens.fontFamily.ui}
          lineHeight="1.5"
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

        {/* Reasoning block — visible during streaming so the developer can
            watch the model's thinking roll out movie-credits style. The block
            handles its own auto-collapse once playback catches up. While the
            reasoning is still rolling (durationMs not yet set), text and tool
            calls are intentionally hidden — the user asked for one channel at
            a time: reasoning first, then everything else. */}
        {message.reasoningContent && (
          <ReasoningBlock
            content={message.reasoningContent}
            isVisible={message.isReasoningVisible || false}
            isStreaming={isStreaming === true && message.reasoningDurationMs == null}
            durationMs={message.reasoningDurationMs}
            onToggle={() => toggleReasoning(message.id)}
          />
        )}

        {/* Gate everything below the reasoning block until the reasoning has
            finished. Signal: `reasoningDurationMs` flips from undefined to a
            number when finalizeAssistantMessage runs OR the first tool_call
            arrives (chatStore: appendReasoningDelta + addPendingToolCall). */}
        {(!message.reasoningContent || message.reasoningDurationMs != null) && (<>

        {/* Interleaved content blocks (text + tool calls in order) */}
        {message.contentBlocks && message.contentBlocks.length > 0 ? (
          <>
            {message.contentBlocks.map((block, idx) => {
              if (block.type === 'text' && block.text) {
                return (
                  <Box key={`text-${idx}`} css={markdownStyles}>
                    <ReactMarkdown components={markdownComponents}>
                      {block.text}
                    </ReactMarkdown>
                  </Box>
                )
              }
              if (block.type === 'tool_call') {
                const tc = message.toolCalls?.find(t => t.id === block.toolCallId)
                if (tc) {
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
              <Box css={markdownStyles}>
                <ReactMarkdown components={markdownComponents}>
                  {message.content}
                </ReactMarkdown>
              </Box>
            )}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <Box mt={message.content ? 3 : 0}>
                {message.toolCalls.map(tc => (
                  <ToolCallDisplayComponent key={tc.id} toolCall={tc} messageId={message.id} />
                ))}
              </Box>
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

        </>)}

        {/* Copy this message + Download whole session — shown after the agent
            finishes the task. The download button serializes the active
            session (messages + tool calls + reasoning + attachments metadata)
            as JSON or Markdown via the browser's save-as dialog. */}
        {!isUser && !isSystem && !isStreaming && copyableText() && (
          <Flex mt={2} justify="flex-end" gap={1} align="center">
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
              onClick={handleCopyMessage}
              title={messageCopied ? t('chat.copied') : t('chat.copyMessage')}
              aria-label={messageCopied ? t('chat.copied') : t('chat.copyMessage')}
            >
              {messageCopied ? <FiCheck size={12} /> : <FiCopy size={12} />}
              <Text fontSize="11px" fontWeight={500}>
                {messageCopied ? t('chat.copied') : t('chat.copyMessage')}
              </Text>
            </Flex>

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
