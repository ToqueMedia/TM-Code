import { memo, useMemo } from 'react'
import { Box, Flex, Text, Image } from '@chakra-ui/react'
import { FiCheck, FiX } from 'react-icons/fi'
import { diffLines } from 'diff'
import { DiffResult } from '../../services/agent/diffService'
import { getFileIconUrl } from '@/utils/fileIcons'
import { tokens } from '@/theme/tokens'
import { detectLanguage, highlightLines, type HighlightedLine } from '@/utils/syntaxHighlight'

interface DiffPreviewProps {
  diff: DiffResult
  onAccept: (diffId: string) => void
  onReject: (diffId: string) => void
}

interface DiffLine {
  type: 'added' | 'removed' | 'normal'
  oldNum: number | null
  newNum: number | null
  sourceLineIdx: number
}

function DiffPreview({ diff, onAccept, onReject }: DiffPreviewProps) {
  const language = useMemo(() => detectLanguage(diff.filePath), [diff.filePath])

  const changes = useMemo(() =>
    diff.isNewFile
      ? [{ value: diff.newContent, added: true, removed: false }]
      : diffLines(diff.originalContent, diff.newContent),
    [diff.originalContent, diff.newContent, diff.isNewFile]
  )

  // Highlighted lines for old and new content
  const oldHighlighted = useMemo(() => highlightLines(diff.originalContent, language), [diff.originalContent, language])
  const newHighlighted = useMemo(() => highlightLines(diff.newContent, language), [diff.newContent, language])

  const { allLines, addedCount, removedCount } = useMemo(() => {
    const lines: DiffLine[] = []
    let oldNum = 1
    let newNum = 1
    let added = 0
    let removed = 0
    for (const change of changes) {
      const changeLines = change.value.replace(/\n$/, '').split('\n')
      const type = change.added ? 'added' as const : change.removed ? 'removed' as const : 'normal' as const
      for (let _ci = 0; _ci < changeLines.length; _ci++) {
        if (type === 'added') {
          lines.push({ type, oldNum: null, newNum, sourceLineIdx: newNum - 1 })
          newNum++
          added++
        } else if (type === 'removed') {
          lines.push({ type, oldNum, newNum: null, sourceLineIdx: oldNum - 1 })
          oldNum++
          removed++
        } else {
          lines.push({ type, oldNum, newNum, sourceLineIdx: newNum - 1 })
          oldNum++
          newNum++
        }
      }
    }
    return { allLines: lines, addedCount: added, removedCount: removed }
  }, [changes])

  const getLineTokens = (line: DiffLine): HighlightedLine => {
    const source = line.type === 'removed' ? oldHighlighted : newHighlighted
    return source[line.sourceLineIdx] || [{ text: '', color: '#f8f9fb' }]
  }

  return (
    <Box
      mb={2}
      bg={tokens.colors.bg.app}
      border={`1px solid ${tokens.colors.border.subtle}`}
      overflow="hidden"
    >
      {/* Editor-like title bar — flat, no border-radius */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py={1}
        bg={tokens.colors.bg.titlebar}
        borderBottom={`1px solid ${tokens.colors.border.subtle}`}
        minH="30px"
      >
        <Flex align="center" gap={2} minW={0}>
          <Image src={getFileIconUrl(diff.filePath)} w="14px" h="14px" flexShrink={0} />
          <Text
            fontSize="12px"
            color={tokens.colors.text.primary}
            fontFamily={tokens.fontFamily.mono}
            fontWeight="400"
            whiteSpace="nowrap"
            overflow="hidden"
            textOverflow="ellipsis"
          >
            {diff.filePath}
          </Text>
          <Flex align="center" gap={1} ml={1} flexShrink={0}>
            {diff.isNewFile ? (
              <Text
                fontSize="10px"
                color={tokens.colors.accent.green}
                fontWeight="500"
                bg="rgba(46, 160, 67, 0.1)"
                px={1}
                borderRadius="3px"
                letterSpacing="0.02em"
              >
                new
              </Text>
            ) : (
              <>
                {addedCount > 0 && (
                  <Text fontSize="10px" color={tokens.colors.diff.addedText} fontFamily={tokens.fontFamily.mono} fontWeight="500">
                    +{addedCount}
                  </Text>
                )}
                {removedCount > 0 && (
                  <Text fontSize="10px" color={tokens.colors.diff.removedText} fontFamily={tokens.fontFamily.mono} fontWeight="500">
                    -{removedCount}
                  </Text>
                )}
              </>
            )}
          </Flex>
        </Flex>

        {/* Inline action buttons — editor code-lens style */}
        <Flex gap={0} align="center">
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="4px"
            px={2}
            py="3px"
            bg="transparent"
            border="none"
            color={tokens.colors.accent.red}
            fontSize="11px"
            fontWeight="400"
            cursor="pointer"
            opacity={0.7}
            _hover={{ opacity: 1, bg: 'rgba(248, 81, 73, 0.08)' }}
            _active={{ opacity: 1 }}
            onClick={() => onReject(diff.id)}
          >
            <FiX size={12} /> Reject
          </Box>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="4px"
            px={2}
            py="3px"
            bg="transparent"
            border="none"
            color={tokens.colors.accent.green}
            fontSize="11px"
            fontWeight="400"
            cursor="pointer"
            opacity={0.7}
            _hover={{ opacity: 1, bg: 'rgba(46, 160, 67, 0.08)' }}
            _active={{ opacity: 1 }}
            onClick={() => onAccept(diff.id)}
          >
            <FiCheck size={12} /> Accept
          </Box>
        </Flex>
      </Flex>

      {/* Diff content — flat, editor-style gutter + code */}
      <Box
        overflowX="auto"
        fontSize="12px"
        fontFamily={tokens.fontFamily.mono}
        lineHeight="20px"
        css={{
          '&::-webkit-scrollbar': { width: '4px', height: '4px' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.08)', borderRadius: '2px' },
        }}
      >
        {allLines.map((line, i) => {
          let bg = 'transparent'
          let prefixChar = '\u00A0'

          if (line.type === 'added') {
            bg = 'rgba(46, 160, 67, 0.06)'
            prefixChar = '+'
          } else if (line.type === 'removed') {
            bg = 'rgba(248, 81, 73, 0.06)'
            prefixChar = '-'
          }

          const gutterTextColor = line.type === 'normal' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.2)'
          const gutterBg = line.type === 'removed' ? 'rgba(248, 81, 73, 0.04)' : line.type === 'added' ? 'rgba(46, 160, 67, 0.03)' : 'transparent'
          const lineTokens = getLineTokens(line)

          return (
            <Flex key={i} bg={bg} align="stretch" minH="20px">
              {/* Old line number */}
              <Flex
                w="40px"
                flexShrink={0}
                justify="flex-end"
                align="center"
                pr="8px"
                bg={gutterBg}
                userSelect="none"
              >
                <Text fontSize="10px" color={gutterTextColor}>
                  {line.oldNum ?? ''}
                </Text>
              </Flex>
              {/* New line number */}
              <Flex
                w="40px"
                flexShrink={0}
                justify="flex-end"
                align="center"
                pr="8px"
                bg={gutterBg}
                borderRight={`1px solid ${line.type === 'added' ? 'rgba(46, 160, 67, 0.12)' : line.type === 'removed' ? 'rgba(248, 81, 73, 0.12)' : 'rgba(255,255,255,0.04)'}`}
                userSelect="none"
              >
                <Text fontSize="10px" color={gutterTextColor}>
                  {line.newNum ?? ''}
                </Text>
              </Flex>
              {/* Prefix */}
              <Flex
                w="20px"
                flexShrink={0}
                justify="center"
                align="center"
                userSelect="none"
              >
                <Text
                  fontSize="11px"
                  color={line.type === 'added' ? tokens.colors.diff.addedText : line.type === 'removed' ? tokens.colors.diff.removedText : 'transparent'}
                  fontWeight="600"
                >
                  {prefixChar}
                </Text>
              </Flex>
              {/* Code — syntax highlighted */}
              <Box flex="1" pr={3} whiteSpace="pre" fontSize="12px" display="flex">
                {lineTokens.map((token, ti) => (
                  <span key={ti} style={{ color: token.color }}>
                    {token.text}
                  </span>
                ))}
              </Box>
            </Flex>
          )
        })}
      </Box>
    </Box>
  )
}

export default memo(DiffPreview)
