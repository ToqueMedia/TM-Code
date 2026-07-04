import { memo, useCallback, useState } from 'react'
import { Flex, Text, Box, Image } from '@chakra-ui/react'
import { FiCheck, FiX, FiCopy } from 'react-icons/fi'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { CodeBlock } from '../../types/chat'
import { tokens } from '@/theme/tokens'
import { getFileIconUrl } from '@/utils/fileIcons'

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
      borderRadius="12px"
      overflow="hidden"
      border={`1px solid ${statusBorderColor}`}
      my={3}
      bg="rgba(10, 10, 10, 0.94)"
      opacity={isRejected ? 0.62 : 1}
      boxShadow={isPending ? '0 16px 38px rgba(0,0,0,0.28)' : '0 10px 26px rgba(0,0,0,0.18)'}
      transition="opacity 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease"
    >
      <Flex
        align="center"
        justify="space-between"
        gap={3}
        px={{ base: 3, md: 4 }}
        py="8px"
        bg="linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.022))"
        borderBottom="1px solid rgba(255, 255, 255, 0.075)"
        flexWrap={{ base: 'wrap', md: 'nowrap' }}
      >
        <Flex align="center" gap={2.5} minW={0}>
          {block.filePath && (
            <Flex
              w="26px"
              h="26px"
              align="center"
              justify="center"
              borderRadius="7px"
              bg="rgba(255,255,255,0.045)"
              border="1px solid rgba(255,255,255,0.07)"
              flexShrink={0}
            >
              <Image src={getFileIconUrl(block.filePath)} alt="" w="15px" h="15px" flexShrink={0} />
            </Flex>
          )}
          {block.filePath && (
            <Text
              fontSize={{ base: '12px', md: '13px' }}
              color={tokens.colors.text.primary}
              fontFamily={tokens.fontFamily.mono}
              fontWeight="600"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {block.filePath}
            </Text>
          )}
          <Text
            fontSize="10px"
            color={tokens.colors.text.disabled}
            fontFamily={tokens.fontFamily.mono}
            fontWeight="700"
            textTransform="uppercase"
            bg="rgba(255,255,255,0.045)"
            border="1px solid rgba(255,255,255,0.07)"
            borderRadius="999px"
            px="7px"
            py="2px"
            lineHeight="1"
            flexShrink={0}
          >
            {block.language || 'text'}
          </Text>
          {isApplied && (
            <Text
              fontSize="10px"
              color={tokens.colors.accent.green}
              fontWeight="700"
              bg="rgba(46, 160, 67, 0.12)"
              border="1px solid rgba(46, 160, 67, 0.22)"
              px="7px"
              py="2px"
              borderRadius="999px"
              lineHeight="1"
            >
              Applied
            </Text>
          )}
          {isRejected && (
            <Text
              fontSize="10px"
              color={tokens.colors.accent.red}
              fontWeight="700"
              bg="rgba(248, 81, 73, 0.12)"
              border="1px solid rgba(248, 81, 73, 0.22)"
              px="7px"
              py="2px"
              borderRadius="999px"
              lineHeight="1"
            >
              Rejected
            </Text>
          )}
        </Flex>

        <Flex align="center" gap={1.5} flexShrink={0} ml={{ base: 0, md: 'auto' }}>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="4px"
            px="9px"
            py="6px"
            borderRadius="8px"
            bg="transparent"
            border="1px solid rgba(255,255,255,0.075)"
            color={copied ? tokens.colors.accent.green : tokens.colors.text.disabled}
            fontSize="11px"
            fontWeight="650"
            cursor="pointer"
            transition="all 0.15s ease"
            _hover={{ bg: 'rgba(255,255,255,0.06)', color: tokens.colors.text.secondary, borderColor: 'rgba(255,255,255,0.14)', transform: 'translateY(-1px)' }}
            _active={{ transform: 'translateY(0) scale(0.98)' }}
            onClick={handleCopy}
            aria-label={copied ? 'Code copied' : 'Copy code'}
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
                px="9px"
                py="6px"
                borderRadius="8px"
                bg="transparent"
                border="1px solid rgba(248, 81, 73, 0.18)"
                color={tokens.colors.accent.red}
                fontSize="11px"
                fontWeight="650"
                cursor="pointer"
                transition="all 0.15s ease"
                _hover={{ bg: 'rgba(248, 81, 73, 0.1)', borderColor: 'rgba(248, 81, 73, 0.32)', transform: 'translateY(-1px)' }}
                _active={{ transform: 'translateY(0) scale(0.98)' }}
                onClick={handleReject}
                aria-label="Reject code block"
              >
                <FiX size={12} />
              </Box>
              <Box
                as="button"
                display="flex"
                alignItems="center"
                gap="4px"
                px="9px"
                py="6px"
                borderRadius="8px"
                bg="rgba(46, 160, 67, 0.13)"
                border="1px solid rgba(46, 160, 67, 0.24)"
                color={tokens.colors.accent.green}
                fontSize="11px"
                fontWeight="650"
                cursor="pointer"
                transition="all 0.15s ease"
                _hover={{ bg: 'rgba(46, 160, 67, 0.2)', borderColor: 'rgba(46, 160, 67, 0.38)', transform: 'translateY(-1px)' }}
                _active={{ transform: 'translateY(0) scale(0.98)' }}
                onClick={handleApply}
                aria-label="Apply code block"
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
          padding: '16px 18px',
          fontSize: '12.5px',
          lineHeight: '1.68',
          background: 'transparent',
          borderRadius: 0,
          textDecoration: isRejected ? 'line-through' : 'none',
          maxWidth: '100%',
          overflowX: 'auto',
        }}
      >
        {block.code}
      </SyntaxHighlighter>
    </Box>
  )
}

export default memo(CodeBlockAction)
