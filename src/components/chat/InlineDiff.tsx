import { memo, useMemo, useState } from 'react'
import { Box, Flex, Text, Image, Kbd } from '@chakra-ui/react'
import { FiCheck, FiCheckCircle, FiX } from 'react-icons/fi'
import { diffLines } from 'diff'
import { getFileIconUrl } from '@/utils/fileIcons'
import { useSettingsStore, formatBinding } from '@/stores/settingsStore'
import { usePermissionStore } from '@/stores/permissionStore'
import { tokens } from '@/theme/tokens'
import { detectLanguage, highlightLines, type HighlightedLine } from '@/utils/syntaxHighlight'

const CONTEXT_LINES = 3
const MAX_LINES = 40

interface InlineDiffProps {
  filePath: string
  oldContent: string
  newContent: string
  isNewFile: boolean
  status: 'pending' | 'approved' | 'denied'
  onApprove: () => void
  onApproveAll: () => void
  onDeny: () => void
  onRejectAll: () => void
}

interface DiffLine {
  type: 'added' | 'removed' | 'normal'
  oldNum: number | null
  newNum: number | null
  /** Index into the highlighted old/new lines array */
  sourceLineIdx: number
}

function InlineDiff({
  filePath,
  oldContent,
  newContent,
  isNewFile,
  status,
  onApprove,
  onApproveAll,
  onDeny,
  onRejectAll,
}: InlineDiffProps) {
  const [showFull, setShowFull] = useState(false)
  const sc = useSettingsStore(s => s.shortcuts)
  const autoApproveDiffs = usePermissionStore(s => s.autoApproveDiffs)
  const fileName = filePath.split('/').pop() || filePath
  const language = useMemo(() => detectLanguage(filePath), [filePath])

  const changes = useMemo(() =>
    isNewFile
      ? [{ value: newContent, added: true, removed: false }]
      : diffLines(oldContent, newContent),
    [oldContent, newContent, isNewFile]
  )

  // Highlighted lines for old and new content
  const oldHighlighted = useMemo(() => highlightLines(oldContent, language), [oldContent, language])
  const newHighlighted = useMemo(() => highlightLines(newContent, language), [newContent, language])

  const allLines = useMemo(() => {
    const lines: DiffLine[] = []
    let oldNum = 1
    let newNum = 1
    for (const change of changes) {
      const changeLines = change.value.replace(/\n$/, '').split('\n')
      const type = change.added ? 'added' as const : change.removed ? 'removed' as const : 'normal' as const
      for (let _ci = 0; _ci < changeLines.length; _ci++) {
        if (type === 'added') {
          lines.push({ type, oldNum: null, newNum: newNum, sourceLineIdx: newNum - 1 })
          newNum++
        } else if (type === 'removed') {
          lines.push({ type, oldNum: oldNum, newNum: null, sourceLineIdx: oldNum - 1 })
          oldNum++
        } else {
          lines.push({ type, oldNum: oldNum, newNum: newNum, sourceLineIdx: newNum - 1 })
          oldNum++
          newNum++
        }
      }
    }
    return lines
  }, [changes])

  const isResolved = status === 'approved' || status === 'denied'
  // Hide approval buttons whenever autoApproveDiffs is on (user already opted
  // into "Accept all", or we're inside a /plan run). Prevents the flicker where
  // buttons briefly appear before the auto-approval phase resolves.
  const showActionButtons = !isResolved && !autoApproveDiffs

  const addedCount = allLines.filter(l => l.type === 'added').length
  const removedCount = allLines.filter(l => l.type === 'removed').length

  // Unified-diff style hunks with CONTEXT_LINES of surrounding context
  // around each changed block. Overlapping or adjacent ranges are merged
  // so non-contiguous changes are separated by a compact "···" row.
  const hunks = useMemo(() => {
    if (allLines.length === 0) return []

    const changedIdxs: number[] = []
    allLines.forEach((line, idx) => {
      if (line.type !== 'normal') changedIdxs.push(idx)
    })
    if (changedIdxs.length === 0) return []

    const ranges: Array<{ start: number; end: number }> = []
    for (const idx of changedIdxs) {
      const start = Math.max(0, idx - CONTEXT_LINES)
      const end = Math.min(allLines.length - 1, idx + CONTEXT_LINES)
      const last = ranges[ranges.length - 1]
      if (last && start <= last.end + 1) {
        last.end = Math.max(last.end, end)
      } else {
        ranges.push({ start, end })
      }
    }

    return ranges.map(({ start, end }) => allLines.slice(start, end + 1))
  }, [allLines])

  const totalDisplayLines = useMemo(
    () => hunks.reduce((n, h) => n + h.length, 0),
    [hunks],
  )
  const shouldTruncate = totalDisplayLines > MAX_LINES && !showFull
  const displayHunks = useMemo(() => {
    if (!shouldTruncate) return hunks
    const out: DiffLine[][] = []
    let remaining = MAX_LINES
    for (const h of hunks) {
      if (remaining <= 0) break
      if (h.length <= remaining) {
        out.push(h)
        remaining -= h.length
      } else {
        out.push(h.slice(0, remaining))
        remaining = 0
      }
    }
    return out
  }, [hunks, shouldTruncate])

  // Get highlighted tokens for a diff line
  const getLineTokens = (line: DiffLine): HighlightedLine => {
    const source = line.type === 'removed' ? oldHighlighted : newHighlighted
    return source[line.sourceLineIdx] || [{ text: '', color: '#f8f9fb' }]
  }

  return (
    <Box
      border={`1px solid ${isResolved ? 'rgba(255,255,255,0.04)' : 'rgba(255, 255, 255, 0.06)'}`}
      borderRadius="10px"
      overflow="hidden"
      my={2}
      bg={tokens.colors.bg.codeBlock}
      transition="all 0.2s"
    >
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py="7px"
        bg="rgba(255, 255, 255, 0.03)"
        borderBottom="1px solid rgba(255, 255, 255, 0.05)"
      >
        <Flex align="center" gap={2}>
          <Image src={getFileIconUrl(filePath)} w="15px" h="15px" flexShrink={0} />
          <Text
            fontSize="12px"
            color={tokens.colors.accent.primary}
            fontFamily={tokens.fontFamily.mono}
            fontWeight="500"
          >
            {fileName}
          </Text>
          {isNewFile && (
            <Text
              fontSize="10px"
              color={tokens.colors.accent.green}
              fontWeight="600"
              bg="rgba(46, 160, 67, 0.1)"
              px="6px"
              py="1px"
              borderRadius="4px"
              textTransform="uppercase"
              letterSpacing="0.03em"
            >
              new
            </Text>
          )}
          {!isNewFile && (
            <Flex align="center" gap={1.5}>
              {addedCount > 0 && (
                <Text fontSize="10px" color={tokens.colors.diff.addedText} fontFamily={tokens.fontFamily.mono}>
                  +{addedCount}
                </Text>
              )}
              {removedCount > 0 && (
                <Text fontSize="10px" color={tokens.colors.diff.removedText} fontFamily={tokens.fontFamily.mono}>
                  -{removedCount}
                </Text>
              )}
            </Flex>
          )}
          {isResolved && (
            <Text
              fontSize="10px"
              fontWeight="600"
              color={status === 'approved' ? tokens.colors.accent.green : tokens.colors.accent.red}
              bg={status === 'approved' ? 'rgba(46, 160, 67, 0.1)' : 'rgba(248, 81, 73, 0.1)'}
              px="6px"
              py="1px"
              borderRadius="4px"
            >
              {status === 'approved' ? 'accepted' : 'rejected'}
            </Text>
          )}
        </Flex>
      </Flex>

      {/* Diff content — only changed lines (+/-) grouped into hunks */}
      <Box
        maxH="320px"
        overflowY="auto"
        overflowX="auto"
        fontSize="12px"
        fontFamily={tokens.fontFamily.mono}
        lineHeight="20px"
        css={{
          '&::-webkit-scrollbar': { width: '4px', height: '4px' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.1)', borderRadius: '2px' },
        }}
      >
        {displayHunks.length === 0 ? (
          <Flex px={3} py="10px" align="center">
            <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
              No changes.
            </Text>
          </Flex>
        ) : (
          displayHunks.map((hunk, hi) => (
            <Box key={`hunk-${hi}`}>
              {hi > 0 && (
                <Flex
                  align="center"
                  h="16px"
                  bg="rgba(255,255,255,0.015)"
                  borderTop="1px dashed rgba(255,255,255,0.06)"
                  borderBottom="1px dashed rgba(255,255,255,0.06)"
                  userSelect="none"
                >
                  <Box w="96px" flexShrink={0} />
                  <Text fontSize="10px" color="rgba(255,255,255,0.25)" fontFamily={tokens.fontFamily.mono}>
                    ···
                  </Text>
                </Flex>
              )}
              {hunk.map((line) => {
                let bg = 'transparent'
                let prefixChar = '\u00A0'
                if (line.type === 'added') {
                  bg = 'rgba(46, 160, 67, 0.08)'
                  prefixChar = '+'
                } else if (line.type === 'removed') {
                  bg = 'rgba(248, 81, 73, 0.08)'
                  prefixChar = '-'
                }
                const gutterBg = line.type === 'removed'
                  ? 'rgba(248, 81, 73, 0.06)'
                  : line.type === 'added'
                    ? 'rgba(46, 160, 67, 0.04)'
                    : 'transparent'
                const gutterBorder = line.type === 'added'
                  ? 'rgba(46, 160, 67, 0.15)'
                  : line.type === 'removed'
                    ? 'rgba(248, 81, 73, 0.15)'
                    : 'rgba(255,255,255,0.06)'
                const gutterTextColor = line.type === 'normal'
                  ? 'rgba(255,255,255,0.15)'
                  : 'rgba(255,255,255,0.25)'
                const lineTokens = getLineTokens(line)
                return (
                  <Flex
                    key={`${line.type}-${line.oldNum ?? 'n'}-${line.newNum ?? 'n'}`}
                    bg={bg}
                    align="stretch"
                    minH="20px"
                  >
                    <Flex
                      w="38px"
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
                    <Flex
                      w="38px"
                      flexShrink={0}
                      justify="flex-end"
                      align="center"
                      pr="8px"
                      bg={gutterBg}
                      borderRight={`1px solid ${gutterBorder}`}
                      userSelect="none"
                    >
                      <Text fontSize="10px" color={gutterTextColor}>
                        {line.newNum ?? ''}
                      </Text>
                    </Flex>
                    <Flex w="20px" flexShrink={0} justify="center" align="center" userSelect="none">
                      <Text
                        fontSize="11px"
                        color={line.type === 'added'
                          ? tokens.colors.diff.addedText
                          : line.type === 'removed'
                            ? tokens.colors.diff.removedText
                            : 'transparent'}
                        fontWeight="700"
                      >
                        {prefixChar}
                      </Text>
                    </Flex>
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
          ))
        )}
      </Box>

      {/* Show more — when truncated */}
      {shouldTruncate && (
        <Box
          px={3}
          py="6px"
          borderTop="1px solid rgba(255, 255, 255, 0.05)"
          bg="rgba(255, 255, 255, 0.02)"
        >
          <Text
            fontSize="11px"
            color={tokens.colors.accent.primary}
            cursor="pointer"
            _hover={{ textDecoration: 'underline' }}
            onClick={() => setShowFull(true)}
          >
            Show {totalDisplayLines - MAX_LINES} more lines
          </Text>
        </Box>
      )}

      {/* Action buttons */}
      {showActionButtons && (
        <Flex
          gap={2}
          px={3}
          py="8px"
          borderTop="1px solid rgba(255, 255, 255, 0.05)"
          bg="rgba(255, 255, 255, 0.02)"
          flexWrap="wrap"
        >
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="5px"
            px="10px"
            py="4px"
            bg="rgba(46, 160, 67, 0.1)"
            border="1px solid rgba(46, 160, 67, 0.2)"
            borderRadius="6px"
            color={tokens.colors.accent.green}
            fontSize="11px"
            fontWeight="500"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(46, 160, 67, 0.18)', borderColor: 'rgba(46, 160, 67, 0.35)' }}
            _active={{ transform: 'scale(0.97)' }}
            onClick={onApprove}
          >
            <FiCheck size={12} />
            Accept
            <Kbd fontSize="9px" color="inherit" opacity={0.5} ml="2px" bg="transparent" borderColor="transparent" p={0}>{formatBinding(sc.diffAccept)}</Kbd>
          </Box>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="5px"
            px="10px"
            py="4px"
            bg="transparent"
            border="1px solid rgba(46, 160, 67, 0.15)"
            borderRadius="6px"
            color={tokens.colors.accent.green}
            fontSize="11px"
            fontWeight="500"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(46, 160, 67, 0.08)', borderColor: 'rgba(46, 160, 67, 0.3)' }}
            _active={{ transform: 'scale(0.97)' }}
            onClick={onApproveAll}
          >
            <FiCheckCircle size={12} />
            Accept all
            <Kbd fontSize="9px" color="inherit" opacity={0.5} ml="2px" bg="transparent" borderColor="transparent" p={0}>{formatBinding(sc.diffAcceptAll)}</Kbd>
          </Box>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="5px"
            px="10px"
            py="4px"
            bg="transparent"
            border="1px solid rgba(248, 81, 73, 0.15)"
            borderRadius="6px"
            color={tokens.colors.accent.red}
            fontSize="11px"
            fontWeight="500"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(248, 81, 73, 0.08)', borderColor: 'rgba(248, 81, 73, 0.3)' }}
            _active={{ transform: 'scale(0.97)' }}
            onClick={onDeny}
          >
            <FiX size={12} />
            Reject
            <Kbd fontSize="9px" color="inherit" opacity={0.5} ml="2px" bg="transparent" borderColor="transparent" p={0}>{formatBinding(sc.diffReject)}</Kbd>
          </Box>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="5px"
            px="10px"
            py="4px"
            bg="rgba(248, 81, 73, 0.1)"
            border="1px solid rgba(248, 81, 73, 0.2)"
            borderRadius="6px"
            color={tokens.colors.accent.red}
            fontSize="11px"
            fontWeight="500"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(248, 81, 73, 0.18)', borderColor: 'rgba(248, 81, 73, 0.35)' }}
            _active={{ transform: 'scale(0.97)' }}
            onClick={onRejectAll}
          >
            <FiX size={12} />
            Reject all
            <Kbd fontSize="9px" color="inherit" opacity={0.5} ml="2px" bg="transparent" borderColor="transparent" p={0}>{formatBinding(sc.diffRejectAll)}</Kbd>
          </Box>
        </Flex>
      )}

      {/* File path footer */}
      <Box
        px={3}
        py="5px"
        bg="rgba(255, 255, 255, 0.02)"
        borderTop="1px solid rgba(255, 255, 255, 0.04)"
      >
        <Text fontSize="10px" color="rgba(255,255,255,0.2)" fontFamily={tokens.fontFamily.mono}>
          {filePath}
        </Text>
      </Box>
    </Box>
  )
}

export default memo(InlineDiff)
