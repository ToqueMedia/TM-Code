import { memo, useCallback, useState } from 'react'
import { Flex, Text, Box } from '@chakra-ui/react'
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
  const [copied, setCopied] = useState(false)

  const handleApply = useCallback(() => onApply(block), [block, onApply])
  const handleReject = useCallback(() => onReject(block), [block, onReject])
  const handleCopy = useCallback(() => {
    onCopy(block.code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [block.code, onCopy])

  const statusBorderColor = isApplied
    ? 'rgba(46, 160, 67, 0.3)'
    : isRejected
    ? 'rgba(248, 81, 73, 0.2)'
    : 'rgba(255, 255, 255, 0.06)'

  return (
    <Box
      borderRadius="10px"
      overflow="hidden"
      border={`1px solid ${statusBorderColor}`}
      my={3}
      bg={tokens.colors.bg.codeBlock}
      opacity={isRejected ? 0.5 : 1}
      transition="opacity 0.2s"
    >
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py="6px"
        bg="rgba(255, 255, 255, 0.03)"
        borderBottom="1px solid rgba(255, 255, 255, 0.05)"
      >
        <Flex align="center" gap={2}>
          {block.filePath && (
            <Text
              fontSize="12px"
              color={tokens.colors.accent.primary}
              fontFamily={tokens.fontFamily.mono}
              fontWeight="500"
            >
              {block.filePath}
            </Text>
          )}
          <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
            {block.language}
          </Text>
          {isApplied && (
            <Text
              fontSize="10px"
              color={tokens.colors.accent.green}
              fontWeight="600"
              bg="rgba(46, 160, 67, 0.1)"
              px="6px"
              py="1px"
              borderRadius="4px"
            >
              Applied
            </Text>
          )}
          {isRejected && (
            <Text
              fontSize="10px"
              color={tokens.colors.accent.red}
              fontWeight="600"
              bg="rgba(248, 81, 73, 0.1)"
              px="6px"
              py="1px"
              borderRadius="4px"
            >
              Rejected
            </Text>
          )}
        </Flex>

        {/* Action buttons */}
        <Flex align="center" gap={1}>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="4px"
            px="7px"
            py="3px"
            borderRadius="5px"
            bg="transparent"
            color={copied ? tokens.colors.accent.green : tokens.colors.text.disabled}
            fontSize="11px"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(255,255,255,0.06)', color: tokens.colors.text.secondary }}
            onClick={handleCopy}
          >
            {copied ? <FiCheck size={11} /> : <FiCopy size={11} />}
            {copied ? 'Copied' : 'Copy'}
          </Box>

          {isPending && (
            <>
              <Box
                as="button"
                display="flex"
                alignItems="center"
                gap="4px"
                px="7px"
                py="3px"
                borderRadius="5px"
                bg="transparent"
                color={tokens.colors.accent.red}
                fontSize="11px"
                cursor="pointer"
                transition="all 0.15s"
                _hover={{ bg: 'rgba(248, 81, 73, 0.1)' }}
                _active={{ transform: 'scale(0.95)' }}
                onClick={handleReject}
              >
                <FiX size={12} />
              </Box>
              <Box
                as="button"
                display="flex"
                alignItems="center"
                gap="4px"
                px="7px"
                py="3px"
                borderRadius="5px"
                bg="transparent"
                color={tokens.colors.accent.green}
                fontSize="11px"
                cursor="pointer"
                transition="all 0.15s"
                _hover={{ bg: 'rgba(46, 160, 67, 0.1)' }}
                _active={{ transform: 'scale(0.95)' }}
                onClick={handleApply}
              >
                <FiCheck size={12} />
                Apply
              </Box>
            </>
          )}
        </Flex>
      </Flex>

      {/* Code */}
      <SyntaxHighlighter
        language={block.language}
        style={vscDarkPlus}
        customStyle={{
          margin: 0,
          padding: '14px 16px',
          fontSize: '12.5px',
          lineHeight: '1.65',
          background: 'transparent',
          borderRadius: 0,
          textDecoration: isRejected ? 'line-through' : 'none',
        }}
      >
        {block.code}
      </SyntaxHighlighter>
    </Box>
  )
}

export default memo(CodeBlockAction)
