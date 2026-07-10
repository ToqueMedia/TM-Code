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
  const diffBorderColor = status === 'approved'
    ? 'rgba(46, 160, 67, 0.28)'
    : status === 'denied'
      ? 'rgba(248, 81, 73, 0.24)'
      : 'rgba(254, 16, 99, 0.22)'
  const diffShadow = status === 'pending'
    ? '0 18px 42px rgba(0,0,0,0.34), 0 0 0 1px rgba(254,16,99,0.04)'
    : '0 12px 30px rgba(0,0,0,0.22)'

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
      border={`1px solid ${diffBorderColor}`}
      borderRadius="12px"
      overflow="hidden"
      my={2}
      bg="rgba(10, 10, 10, 0.94)"
      boxShadow={diffShadow}
      transition="border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease"
    >
      <Flex
        align="center"
        justify="space-between"
        gap={3}
        px={{ base: 3, md: 4 }}
        minH="44px"
        py="8px"
        bg="linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.022))"
        borderBottom="1px solid rgba(255, 255, 255, 0.075)"
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
            <Image src={getFileIconUrl(filePath)} alt="" w="15px" h="15px" flexShrink={0} />
          </Flex>
          <Text
            fontSize={{ base: '12px', md: '13px' }}
            color={tokens.colors.text.primary}
            fontFamily={tokens.fontFamily.mono}
            fontWeight="600"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
          >
            {fileName}
          </Text>
          {isNewFile && (
            <Text
              fontSize="10px"
              color={tokens.colors.accent.green}
              fontWeight="700"
              bg="rgba(46, 160, 67, 0.12)"
              border="1px solid rgba(46, 160, 67, 0.22)"
              px="7px"
              py="2px"
              borderRadius="999px"
              textTransform="uppercase"
              lineHeight="1"
            >
              new
            </Text>
          )}
          {!isNewFile && (
            <Flex align="center" gap={1.5}>
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
            </Flex>
          )}
          {isResolved && (
            <Text
              fontSize="10px"
              fontWeight="600"
              color={status === 'approved' ? tokens.colors.accent.green : tokens.colors.accent.red}
              bg={status === 'approved' ? 'rgba(46, 160, 67, 0.12)' : 'rgba(248, 81, 73, 0.12)'}
              border={status === 'approved' ? '1px solid rgba(46, 160, 67, 0.2)' : '1px solid rgba(248, 81, 73, 0.2)'}
              px="7px"
              py="2px"
              borderRadius="999px"
              lineHeight="1"
            >
              {status === 'approved' ? 'accepted' : 'rejected'}
            </Text>
          )}
        </Flex>
      </Flex>

      {/* Diff content — editor-like grid. Long lines wrap inside the code
          column, while fixed gutter columns keep line numbers aligned. */}
      <Box
        overflowX="hidden"
        fontSize={{ base: '11.5px', md: '12px' }}
        fontFamily={tokens.fontFamily.mono}
        lineHeight="21px"
        bg="rgba(0,0,0,0.16)"
        css={{
          '&::-webkit-scrollbar': { width: '4px', height: '4px' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.14)', borderRadius: '2px' },
          // Container query on the diff body itself: the transcript column
          // shrinks with the preview split and the side drawers (team chat,
          // terminal) while the viewport stays put, so a viewport @media
          // never fired on desktop — diffs kept the wide 44px gutters even
          // inside a 380px sidebar chat. Measuring the diff's own box makes
          // the narrow gutters kick in wherever the diff actually renders.
          containerType: 'inline-size',
          '@container (max-width: 560px)': {
            '& [data-diff-row], & [data-diff-gap]': {
              gridTemplateColumns: '34px 34px 18px minmax(0, 1fr)',
            },
          },
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
                <Box
                  data-diff-gap
                  h="16px"
                  bg="rgba(255,255,255,0.025)"
                  borderTop="1px dashed rgba(255,255,255,0.075)"
                  borderBottom="1px dashed rgba(255,255,255,0.075)"
                  userSelect="none"
                  display="grid"
                  alignItems="center"
                  gridTemplateColumns="44px 44px 22px minmax(0, 1fr)"
                  minW={0}
                >
                  <Text gridColumn="4" fontSize="10px" color="rgba(255,255,255,0.25)" fontFamily={tokens.fontFamily.mono}>
                    ···
                  </Text>
                </Box>
              )}
              {hunk.map((line) => {
                let bg = 'transparent'
                let prefixChar = '\u00A0'
                if (line.type === 'added') {
                  bg = 'rgba(46, 160, 67, 0.085)'
                  prefixChar = '+'
                } else if (line.type === 'removed') {
                  bg = 'rgba(248, 81, 73, 0.085)'
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
                  <Box
                    key={`${line.type}-${line.oldNum ?? 'n'}-${line.newNum ?? 'n'}`}
                    data-diff-row
                    bg={bg}
                    minH="21px"
                    display="grid"
                    gridTemplateColumns="44px 44px 22px minmax(0, 1fr)"
                    minW={0}
                    boxShadow={line.type === 'added'
                      ? 'inset 2px 0 0 rgba(46, 160, 67, 0.58)'
                      : line.type === 'removed'
                        ? 'inset 2px 0 0 rgba(248, 81, 73, 0.58)'
                        : 'none'}
                  >
                    <Box
                      minH="21px"
                      display="flex"
                      justifyContent="flex-end"
                      alignItems="flex-start"
                      pt="2px"
                      pr="10px"
                      bg={gutterBg}
                      userSelect="none"
                    >
                      <Text fontSize="10px" lineHeight="21px" color={gutterTextColor} whiteSpace="nowrap">
                        {line.oldNum ?? ''}
                      </Text>
                    </Box>
                    <Box
                      minH="21px"
                      display="flex"
                      justifyContent="flex-end"
                      alignItems="flex-start"
                      pt="2px"
                      pr="10px"
                      bg={gutterBg}
                      borderRight={`1px solid ${gutterBorder}`}
                      userSelect="none"
                    >
                      <Text fontSize="10px" lineHeight="21px" color={gutterTextColor} whiteSpace="nowrap">
                        {line.newNum ?? ''}
                      </Text>
                    </Box>
                    <Flex minH="21px" justify="center" align="flex-start" pt="2px" userSelect="none">
                      <Text
                        fontSize="11px"
                        lineHeight="21px"
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
                    <Box
                      minW={0}
                      pr={{ base: 3, md: 4 }}
                      whiteSpace="pre-wrap"
                      overflowWrap="anywhere"
                      fontSize={{ base: '11.5px', md: '12px' }}
                      lineHeight="21px"
                    >
                      {lineTokens.map((token, ti) => (
                        <span key={ti} style={{ color: token.color }}>
                          {token.text}
                        </span>
                      ))}
                    </Box>
                  </Box>
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
          py="8px"
          borderTop="1px solid rgba(255, 255, 255, 0.065)"
          bg="rgba(255, 255, 255, 0.025)"
        >
          <Text
            as="button"
            fontSize="11px"
            color={tokens.colors.accent.primary}
            cursor="pointer"
            fontWeight="600"
            _hover={{ color: '#ff4f8c' }}
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
          px={{ base: 3, md: 4 }}
          py="10px"
          borderTop="1px solid rgba(255, 255, 255, 0.075)"
          bg="rgba(255, 255, 255, 0.026)"
          flexWrap="wrap"
        >
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="5px"
            px="11px"
            py="6px"
            bg="rgba(46, 160, 67, 0.13)"
            border="1px solid rgba(46, 160, 67, 0.24)"
            borderRadius="8px"
            color={tokens.colors.accent.green}
            fontSize="11px"
            fontWeight="650"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(46, 160, 67, 0.2)', borderColor: 'rgba(46, 160, 67, 0.38)', transform: 'translateY(-1px)' }}
            _active={{ transform: 'translateY(0) scale(0.98)' }}
            onClick={onApprove}
            aria-label={`Accept changes in ${fileName}`}
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
            px="11px"
            py="6px"
            bg="transparent"
            border="1px solid rgba(46, 160, 67, 0.18)"
            borderRadius="8px"
            color={tokens.colors.accent.green}
            fontSize="11px"
            fontWeight="650"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(46, 160, 67, 0.1)', borderColor: 'rgba(46, 160, 67, 0.32)', transform: 'translateY(-1px)' }}
            _active={{ transform: 'translateY(0) scale(0.98)' }}
            onClick={onApproveAll}
            aria-label="Accept all pending changes"
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
            px="11px"
            py="6px"
            bg="transparent"
            border="1px solid rgba(248, 81, 73, 0.18)"
            borderRadius="8px"
            color={tokens.colors.accent.red}
            fontSize="11px"
            fontWeight="650"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(248, 81, 73, 0.1)', borderColor: 'rgba(248, 81, 73, 0.32)', transform: 'translateY(-1px)' }}
            _active={{ transform: 'translateY(0) scale(0.98)' }}
            onClick={onDeny}
            aria-label={`Reject changes in ${fileName}`}
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
            px="11px"
            py="6px"
            bg="rgba(248, 81, 73, 0.13)"
            border="1px solid rgba(248, 81, 73, 0.24)"
            borderRadius="8px"
            color={tokens.colors.accent.red}
            fontSize="11px"
            fontWeight="650"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ bg: 'rgba(248, 81, 73, 0.2)', borderColor: 'rgba(248, 81, 73, 0.38)', transform: 'translateY(-1px)' }}
            _active={{ transform: 'translateY(0) scale(0.98)' }}
            onClick={onRejectAll}
            aria-label="Reject all pending changes"
          >
            <FiX size={12} />
            Reject all
            <Kbd fontSize="9px" color="inherit" opacity={0.5} ml="2px" bg="transparent" borderColor="transparent" p={0}>{formatBinding(sc.diffRejectAll)}</Kbd>
          </Box>
        </Flex>
      )}

      {/* File path footer */}
      <Box
        px={{ base: 3, md: 4 }}
        py="7px"
        bg="rgba(255, 255, 255, 0.018)"
        borderTop="1px solid rgba(255, 255, 255, 0.055)"
      >
        <Text fontSize="10px" color="rgba(255,255,255,0.28)" fontFamily={tokens.fontFamily.mono} truncate>
          {filePath}
        </Text>
      </Box>
    </Box>
  )
}

export default memo(InlineDiff)
