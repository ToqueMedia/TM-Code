import { lazy, memo, Suspense, useCallback, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiCheck, FiCopy } from 'react-icons/fi'
import type { CodeBlock } from '../../types/chat'
import { tokens } from '@/theme/tokens'
import { basename } from '@/utils/platform'

// Prism + vscDarkPlus theme are heavy. Defer until a code block actually renders.
const LazyHighlighter = lazy(async () => {
  const [{ Prism }, styleMod] = await Promise.all([
    import('react-syntax-highlighter'),
    import('react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus'),
  ])
  const style = (styleMod as { default: Record<string, React.CSSProperties> }).default
  const Comp: React.FC<{ language: string; children: string }> = ({ language, children }) => (
    <Prism
      language={language}
      style={style}
      wrapLines={true}
      wrapLongLines={true}
      customStyle={{
        background: 'transparent',
        margin: 0,
        padding: '10px 12px',
        fontSize: '12px',
        lineHeight: '1.55',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {children}
    </Prism>
  )
  return { default: Comp }
})

interface TerminalCodeBlockProps {
  block: CodeBlock
}

export const TerminalCodeBlock = memo(function TerminalCodeBlock({ block }: TerminalCodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(block.code).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [block.code])

  const lang = block.language || 'text'
  const file = block.filePath ? basename(String(block.filePath)) : null

  return (
    <Box
      my={2}
      border="1px solid rgba(255,255,255,0.075)"
      borderRadius="10px"
      overflow="hidden"
      bg="rgba(0,0,0,0.28)"
      data-no-focus-steal
      maxW="100%"
    >
      <Flex
        align="center"
        justify="space-between"
        gap={2}
        px={3}
        py="7px"
        bg="rgba(255,255,255,0.032)"
        borderBottom="1px solid rgba(255,255,255,0.06)"
      >
        <Flex align="center" gap={2} minW={0}>
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
            {lang}
          </Text>
          {file && (
            <Text
              fontSize="11px"
              color={tokens.colors.text.secondary}
              fontFamily={tokens.fontFamily.mono}
              fontWeight="600"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {file}
            </Text>
          )}
        </Flex>
        <Flex
          as="button"
          aria-label="Copy code"
          align="center"
          gap={1.5}
          px="8px"
          py="5px"
          borderRadius="7px"
          border="1px solid rgba(255,255,255,0.075)"
          color={copied ? tokens.colors.accent.green : tokens.colors.text.disabled}
          bg="transparent"
          fontSize="10px"
          fontFamily={tokens.fontFamily.mono}
          fontWeight="700"
          textTransform="uppercase"
          onClick={handleCopy}
          cursor="pointer"
          _hover={{ bg: 'rgba(255,255,255,0.055)', color: copied ? tokens.colors.accent.green : tokens.colors.text.secondary }}
          transition="all 0.14s ease"
          flexShrink={0}
        >
          {copied ? <FiCheck size={11} /> : <FiCopy size={11} />}
          {copied ? 'copied' : 'copy'}
        </Flex>
      </Flex>

      <Box bg="rgba(0,0,0,0.22)" overflow="hidden">
        <Suspense fallback={<CodeFallback code={block.code} />}>
          <LazyHighlighter language={lang}>{block.code}</LazyHighlighter>
        </Suspense>
      </Box>
    </Box>
  )
})

function CodeFallback({ code }: { code: string }) {
  return (
    <Box
      as="pre"
      m={0}
      p="10px 12px"
      fontSize="12px"
      lineHeight="1.55"
      fontFamily={tokens.fontFamily.mono}
      color={tokens.colors.text.secondary}
      whiteSpace="pre-wrap"
      wordBreak="break-word"
    >
      {code}
    </Box>
  )
}
