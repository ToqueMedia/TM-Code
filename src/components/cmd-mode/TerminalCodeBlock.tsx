import { lazy, memo, Suspense, useCallback, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
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
        padding: '6px 8px',
        fontSize: '12px',
        lineHeight: '1.45',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
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
    <Box my={1.5} pl={2} borderLeft={`2px solid rgba(255,255,255,0.08)`} data-no-focus-steal maxW="100%">
      {/* Header: lang + file + copy */}
      <Flex align="center" justify="space-between" mb="3px">
        <Flex align="center" gap={2}>
          <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} fontWeight="600" textTransform="uppercase" letterSpacing="0.06em">
            {lang}
          </Text>
          {file && (
            <Text fontSize="10px" color={tokens.colors.accent.purple} fontFamily={tokens.fontFamily.mono} opacity={0.8}>
              {file}
            </Text>
          )}
        </Flex>
        <Text
          as="button"
          aria-label="Copy code"
          fontSize="9px"
          color={copied ? tokens.colors.accent.green : tokens.colors.text.disabled}
          fontFamily={tokens.fontFamily.mono}
          fontWeight="600"
          letterSpacing="0.06em"
          textTransform="uppercase"
          onClick={handleCopy}
          cursor="pointer"
          _hover={{ color: copied ? tokens.colors.accent.green : tokens.colors.text.secondary }}
          transition="color 0.1s"
        >
          {copied ? '✓ copied' : 'copy'}
        </Text>
      </Flex>

      {/* Code — flat surface: ≤2px radius, 1px hairline only, no shadow. */}
      <Box borderRadius={tokens.radius.sm} bg="rgba(0,0,0,0.35)" overflow="hidden" border="1px solid rgba(255,255,255,0.04)">
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
      p="6px 8px"
      fontSize="12px"
      lineHeight="1.45"
      fontFamily={tokens.fontFamily.mono}
      color={tokens.colors.text.secondary}
      whiteSpace="pre-wrap"
      wordBreak="break-word"
    >
      {code}
    </Box>
  )
}
