import { memo, useCallback } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { ChatMessage } from '../../types/chat'
import { useChatStore } from '../../stores/chatStore'
import CodeBlockAction from './CodeBlockAction'
import ToolCallDisplayComponent from './ToolCallDisplay'
import { tokens } from '@/theme/tokens'

interface MessageBubbleProps {
  message: ChatMessage
  isStreaming?: boolean
}

function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const updateCodeBlockStatus = useChatStore(s => s.updateCodeBlockStatus)

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

  return (
    <Flex
      justify={isUser ? 'flex-end' : 'flex-start'}
      mb={3}
      px={3}
    >
      <Box
        maxW="85%"
        bg={isUser ? tokens.colors.chat.userBubble : tokens.colors.chat.assistantBubble}
        borderRadius="10px"
        px={4}
        py={3}
        position="relative"
      >
        <Box
          css={{
            '& p': {
              margin: '0 0 8px 0',
              lineHeight: '1.6',
              fontSize: '13px',
              color: tokens.colors.text.primary,
            },
            '& p:last-child': {
              marginBottom: 0,
            },
            '& strong': {
              color: tokens.colors.markdown.strong,
              fontWeight: 600,
            },
            '& em': {
              color: tokens.colors.markdown.emphasis,
            },
            '& ul, & ol': {
              margin: '4px 0',
              paddingLeft: '20px',
              fontSize: '13px',
              color: tokens.colors.text.primary,
            },
            '& li': {
              marginBottom: '2px',
            },
            '& a': {
              color: tokens.colors.markdown.link,
              textDecoration: 'none',
              '&:hover': {
                textDecoration: 'underline',
              },
            },
            '& code': {
              background: tokens.colors.bg.codeInline,
              borderRadius: '3px',
              padding: '2px 6px',
              fontSize: '12px',
              fontFamily: tokens.fontFamily.mono,
              color: tokens.colors.text.code,
            },
            '& pre': {
              margin: 0,
              padding: 0,
            },
            '& pre code': {
              background: 'none',
              padding: 0,
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
                    <Box borderRadius="6px" overflow="hidden" my={2}>
                      <Flex
                        align="center"
                        px={3}
                        py={1}
                        bg={tokens.colors.bg.codeBlockHeader}
                        borderBottom={`1px solid ${tokens.colors.border.default}`}
                      >
                        <Text fontSize="xs" color={tokens.colors.text.subtle}>{match[1]}</Text>
                      </Flex>
                      <SyntaxHighlighter
                        style={vscDarkPlus}
                        language={match[1]}
                        customStyle={{
                          margin: 0,
                          padding: '12px',
                          fontSize: '13px',
                          background: tokens.colors.bg.codeBlock,
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

        {/* Render tool calls inline */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <Box mt={2}>
            {message.toolCalls.map(tc => (
              <ToolCallDisplayComponent key={tc.id} toolCall={tc} />
            ))}
          </Box>
        )}

        {/* Render standalone code blocks from SSE */}
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
            h="16px"
            bg={tokens.colors.accent.primary}
            ml={1}
            verticalAlign="text-bottom"
            animation="blink 1s step-end infinite"
            css={{
              '@keyframes blink': {
                '0%, 100%': { opacity: 1 },
                '50%': { opacity: 0 },
              },
            }}
          />
        )}
      </Box>
    </Flex>
  )
}

export default memo(MessageBubble)
