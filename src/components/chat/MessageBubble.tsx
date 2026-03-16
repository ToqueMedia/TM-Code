import { memo, useCallback, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiUser, FiCopy, FiCheck } from 'react-icons/fi'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { ChatMessage } from '../../types/chat'
import { useChatStore } from '../../stores/chatStore'
import CodeBlockAction from './CodeBlockAction'
import ToolCallDisplayComponent from './ToolCallDisplay'
import ReasoningBlock from './ReasoningBlock'
import { tokens } from '@/theme/tokens'

interface MessageBubbleProps {
  message: ChatMessage
  isStreaming?: boolean
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
      {copied ? 'Copied' : 'Copy'}
    </Box>
  )
}

function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const updateCodeBlockStatus = useChatStore(s => s.updateCodeBlockStatus)
  const toggleReasoning = useChatStore(s => s.toggleReasoning)

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

  // System messages: compact status line
  if (isSystem) {
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
          <Flex
            w="22px"
            h="22px"
            borderRadius="6px"
            bgGradient={tokens.gradient.accentPrimary}
            align="center"
            justify="center"
            flexShrink={0}
            boxShadow="0 2px 8px rgba(254, 16, 99, 0.25)"
          >
            <Text fontSize="10px" color="white" fontWeight="800" lineHeight="1">
              ◆
            </Text>
          </Flex>
        )}
        <Text
          fontSize="13px"
          fontWeight="600"
          color={tokens.colors.text.primary}
          letterSpacing="-0.01em"
        >
          {isUser ? 'You' : 'Diamond'}
        </Text>
        {isStreaming && !isUser && (
          <Box
            w="5px"
            h="5px"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            animation="msgPulse 1.5s ease-in-out infinite"
            css={{
              '@keyframes msgPulse': {
                '0%, 100%': { opacity: 1 },
                '50%': { opacity: 0.25 },
              },
            }}
          />
        )}
      </Flex>

      {/* Content area */}
      <Box pl="34px">
        {/* Reasoning block */}
        {message.reasoningContent && (
          <ReasoningBlock
            content={message.reasoningContent}
            isVisible={message.isReasoningVisible || false}
            isStreaming={isStreaming || false}
            onToggle={() => toggleReasoning(message.id)}
          />
        )}

        {/* Markdown content */}
        {message.content && (
          <Box
            css={{
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
                borderCollapse: 'collapse',
                width: '100%',
                margin: '10px 0',
                fontSize: '12.5px',
              },
              '& th, & td': {
                border: `1px solid ${tokens.colors.border.subtle}`,
                padding: '7px 12px',
                textAlign: 'left',
              },
              '& th': {
                background: 'rgba(255, 255, 255, 0.03)',
                fontWeight: 600,
                color: '#ffffff',
              },
            }}
          >
            <ReactMarkdown
              components={{
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
              }}
            >
              {message.content}
            </ReactMarkdown>
          </Box>
        )}

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <Box mt={message.content ? 3 : 0}>
            {message.toolCalls.map(tc => (
              <ToolCallDisplayComponent key={tc.id} toolCall={tc} messageId={message.id} />
            ))}
          </Box>
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

        {/* Streaming cursor */}
        {isStreaming && (
          <Box
            as="span"
            display="inline-block"
            w="2px"
            h="15px"
            bg={tokens.colors.accent.primary}
            ml={1}
            mt={1}
            verticalAlign="text-bottom"
            borderRadius="1px"
            animation="cursorBlink 1s step-end infinite"
            css={{
              '@keyframes cursorBlink': {
                '0%, 100%': { opacity: 1 },
                '50%': { opacity: 0 },
              },
            }}
          />
        )}
      </Box>
    </Box>
  )
}

export default memo(MessageBubble)
