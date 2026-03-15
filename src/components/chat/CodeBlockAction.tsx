import { memo, useCallback } from 'react'
import { Flex, Text, Box, IconButton } from '@chakra-ui/react'
import { FiCheck, FiX, FiCopy } from 'react-icons/fi'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { CodeBlock } from '../../types/chat'
import { tokens } from '@/theme/tokens'

interface CodeBlockActionProps {
  block: CodeBlock
  messageId: string
  onApply: (block: CodeBlock) => void
  onReject: (block: CodeBlock) => void
  onCopy: (code: string) => void
}

function CodeBlockAction({ block, onApply, onReject, onCopy }: CodeBlockActionProps) {
  const isApplied = block.status === 'applied'
  const isRejected = block.status === 'rejected'
  const isPending = block.status === 'pending'

  const handleApply = useCallback(() => {
    onApply(block)
  }, [block, onApply])

  const handleReject = useCallback(() => {
    onReject(block)
  }, [block, onReject])

  const handleCopy = useCallback(() => {
    onCopy(block.code)
  }, [block.code, onCopy])

  return (
    <Box
      borderRadius="6px"
      overflow="hidden"
      border="1px solid"
      borderColor={isApplied ? tokens.colors.accent.green : isRejected ? tokens.colors.accent.red : tokens.colors.border.default}
      my={2}
    >
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py={1.5}
        bg={tokens.colors.bg.codeBlockHeader}
        borderBottom={`1px solid ${tokens.colors.border.default}`}
      >
        <Flex align="center" gap={2}>
          {block.filePath && (
            <Text fontSize="xs" color={tokens.colors.accent.primary} fontFamily="mono">
              {block.filePath}
            </Text>
          )}
          <Text fontSize="xs" color={tokens.colors.text.subtle}>
            {block.language}
          </Text>
        </Flex>
        {isApplied && (
          <Text fontSize="xs" color={tokens.colors.accent.green} fontWeight="600">Applied</Text>
        )}
        {isRejected && (
          <Text fontSize="xs" color={tokens.colors.accent.red} fontWeight="600" textDecoration="line-through">Rejected</Text>
        )}
      </Flex>

      {/* Code */}
      <Box
        opacity={isRejected ? 0.5 : 1}
        textDecoration={isRejected ? 'line-through' : 'none'}
      >
        <SyntaxHighlighter
          language={block.language}
          style={vscDarkPlus}
          customStyle={{
            margin: 0,
            padding: '12px',
            fontSize: '13px',
            background: tokens.colors.bg.codeBlock,
            borderRadius: 0,
          }}
        >
          {block.code}
        </SyntaxHighlighter>
      </Box>

      {/* Actions */}
      <Flex
        align="center"
        justify="flex-end"
        gap={1}
        px={2}
        py={1.5}
        bg={tokens.colors.bg.codeBlockHeader}
        borderTop={`1px solid ${tokens.colors.border.default}`}
      >
        <IconButton
          aria-label="Copy code"
          size="xs"
          variant="ghost"
          color={tokens.colors.text.subtle}
          _hover={{ color: tokens.colors.text.inverse, bg: 'whiteAlpha.100' }}
          onClick={handleCopy}
        >
          <FiCopy size={14} />
        </IconButton>

        {isPending && (
          <>
            <IconButton
              aria-label="Reject code"
              size="xs"
              variant="ghost"
              color={tokens.colors.accent.red}
              _hover={{ bg: tokens.colors.accent.redSubtle }}
              onClick={handleReject}
            >
              <FiX size={14} />
            </IconButton>
            <IconButton
              aria-label="Apply code"
              size="xs"
              variant="ghost"
              color={tokens.colors.accent.green}
              _hover={{ bg: tokens.colors.accent.greenSubtle }}
              onClick={handleApply}
            >
              <FiCheck size={14} />
            </IconButton>
          </>
        )}
      </Flex>
    </Box>
  )
}

export default memo(CodeBlockAction)
