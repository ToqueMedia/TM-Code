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
      mb={3}
      bg="rgba(10, 10, 10, 0.94)"
      border="1px solid rgba(255,255,255,0.09)"
      borderRadius="12px"
      overflow="hidden"
      boxShadow="0 16px 38px rgba(0,0,0,0.28)"
    >
      <Flex
        align="center"
        justify="space-between"
        gap={3}
        px={{ base: 3, md: 4 }}
        py="8px"
        bg="linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.022))"
        borderBottom="1px solid rgba(255, 255, 255, 0.075)"
        minH="44px"
        flexWrap={{ base: 'wrap', md: 'nowrap' }}
      >
        <Flex align="center" gap={2.5} minW={0}>
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
            <Image src={getFileIconUrl(diff.filePath)} alt="" w="15px" h="15px" flexShrink={0} />
          </Flex>
          <Text
            fontSize={{ base: '12px', md: '13px' }}
            color={tokens.colors.text.primary}
            fontFamily={tokens.fontFamily.mono}
            fontWeight="600"
            whiteSpace="nowrap"
            overflow="hidden"
            textOverflow="ellipsis"
          >
            {diff.filePath}
          </Text>
          <Flex align="center" gap={1.5} ml={1} flexShrink={0}>
            {diff.isNewFile ? (
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
                new
              </Text>
            ) : (
              <>
                {addedCount > 0 && (
                  <Text
                    fontSize="10px"
                    color={tokens.colors.diff.addedText}
                    fontFamily={tokens.fontFamily.mono}
                    fontWeight="700"
                    bg="rgba(46, 160, 67, 0.105)"
                    border="1px solid rgba(46, 160, 67, 0.18)"
                    px="6px"
                    py="2px"
                    borderRadius="999px"
                    lineHeight="1"
                  >
                    +{addedCount}
                  </Text>
                )}
                {removedCount > 0 && (
                  <Text
                    fontSize="10px"
                    color={tokens.colors.diff.removedText}
                    fontFamily={tokens.fontFamily.mono}
                    fontWeight="700"
                    bg="rgba(248, 81, 73, 0.105)"
                    border="1px solid rgba(248, 81, 73, 0.18)"
                    px="6px"
                    py="2px"
                    borderRadius="999px"
                    lineHeight="1"
                  >
                    -{removedCount}
                  </Text>
                )}
              </>
            )}
          </Flex>
        </Flex>

        <Flex gap={1.5} align="center" flexShrink={0} ml={{ base: 0, md: 'auto' }}>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="4px"
            px="9px"
            py="6px"
            bg="transparent"
            border="1px solid rgba(248, 81, 73, 0.18)"
            borderRadius="8px"
            color={tokens.colors.accent.red}
            fontSize="11px"
            fontWeight="650"
            cursor="pointer"
            opacity={0.7}
            transition="all 0.15s ease"
            _hover={{ opacity: 1, bg: 'rgba(248, 81, 73, 0.1)', borderColor: 'rgba(248, 81, 73, 0.32)', transform: 'translateY(-1px)' }}
            _active={{ opacity: 1 }}
            onClick={() => onReject(diff.id)}
            aria-label={`Reject changes in ${diff.filePath}`}
          >
            <FiX size={12} /> Reject
          </Box>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="4px"
            px="9px"
            py="6px"
            bg="rgba(46, 160, 67, 0.13)"
            border="1px solid rgba(46, 160, 67, 0.24)"
            borderRadius="8px"
            color={tokens.colors.accent.green}
            fontSize="11px"
            fontWeight="650"
            cursor="pointer"
            opacity={0.7}
            transition="all 0.15s ease"
            _hover={{ opacity: 1, bg: 'rgba(46, 160, 67, 0.2)', borderColor: 'rgba(46, 160, 67, 0.38)', transform: 'translateY(-1px)' }}
            _active={{ opacity: 1 }}
            onClick={() => onAccept(diff.id)}
            aria-label={`Accept changes in ${diff.filePath}`}
          >
            <FiCheck size={12} /> Accept
          </Box>
        </Flex>
      </Flex>

      <Box
        overflowX="auto"
        fontSize={{ base: '11.5px', md: '12px' }}
        fontFamily={tokens.fontFamily.mono}
        lineHeight="21px"
        bg="rgba(0,0,0,0.16)"
        css={{
          '&::-webkit-scrollbar': { width: '4px', height: '4px' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.14)', borderRadius: '2px' },
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
            <Flex
              key={i}
              bg={bg}
              align="stretch"
              minH="21px"
              boxShadow={line.type === 'added'
                ? 'inset 2px 0 0 rgba(46, 160, 67, 0.58)'
                : line.type === 'removed'
                  ? 'inset 2px 0 0 rgba(248, 81, 73, 0.58)'
                  : 'none'}
            >
              <Flex
                w="40px"
                flexShrink={0}
                justify="flex-end"
                align="center"
                pr="8px"
                bg={gutterBg}
                userSelect="none"
              >
                <Text fontSize="10px" color={gutterTextColor} lineHeight="21px">
                  {line.oldNum ?? ''}
                </Text>
              </Flex>
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
                <Text fontSize="10px" color={gutterTextColor} lineHeight="21px">
                  {line.newNum ?? ''}
                </Text>
              </Flex>
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
              <Box flex="1" pr={3} whiteSpace="pre" fontSize={{ base: '11.5px', md: '12px' }} display="flex" minW={0}>
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
