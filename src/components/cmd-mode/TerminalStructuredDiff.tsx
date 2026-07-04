import { memo, useMemo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { structuredPatch } from 'diff'
import { tokens } from '@/theme/tokens'

/**
 * For new-file creates, show only the first N lines (matching claude-vaz
 * FileWriteTool behavior).
 */
const MAX_CREATE_LINES = 10

/**
 * Safety cap for edit diffs — prevents rendering thousands of DOM nodes on
 * large file rewrites (e.g. renaming a variable across 2000 lines).
 * Matched to claude-vaz's MAX_LINES_PER_FILE = 400.
 */
const MAX_EDIT_LINES = 400

interface TerminalStructuredDiffProps {
  filePath: string
  oldContent: string
  newContent: string
  isNewFile?: boolean
  contextLines?: number
  maxHunks?: number
}

type Row =
  | { kind: 'context'; oldNo: number; newNo: number; text: string }
  | { kind: 'add'; newNo: number; text: string }
  | { kind: 'remove'; oldNo: number; text: string }
  | { kind: 'hunkHeader'; label: string }

export const TerminalStructuredDiff = memo(function TerminalStructuredDiff({
  filePath,
  oldContent,
  newContent,
  isNewFile = false,
  contextLines = 3,
  maxHunks = 8,
}: TerminalStructuredDiffProps) {
  const { rows, addedTotal, removedTotal, hiddenCount } = useMemo(() => {
    const oldText = (oldContent ?? '').replace(/\r\n/g, '\n')
    const newText = (newContent ?? '').replace(/\r\n/g, '\n')

    // New file: show first MAX_CREATE_LINES, then "+X lines" note
    if (isNewFile || oldText === '') {
      const lines = newText.split('\n')
      const capped = lines.slice(0, MAX_CREATE_LINES)
      const r: Row[] = []
      capped.forEach((line, i) => r.push({ kind: 'add', newNo: i + 1, text: line }))
      return { rows: r, addedTotal: lines.length, removedTotal: 0, hiddenCount: Math.max(0, lines.length - MAX_CREATE_LINES) }
    }

    // File deletion: show first MAX_CREATE_LINES
    if (newText === '') {
      const lines = oldText.split('\n')
      const capped = lines.slice(0, MAX_CREATE_LINES)
      const r: Row[] = []
      capped.forEach((line, i) => r.push({ kind: 'remove', oldNo: i + 1, text: line }))
      return { rows: r, addedTotal: 0, removedTotal: lines.length, hiddenCount: Math.max(0, lines.length - MAX_CREATE_LINES) }
    }

    // Edit: show full diff with safety cap (MAX_EDIT_LINES) to prevent
    // WebView freeze on large rewrites.
    const patch = structuredPatch(filePath, filePath, oldText, newText, '', '', { context: contextLines })
    const hunks = patch.hunks

    let addedTotal = 0
    let removedTotal = 0
    hunks.forEach((h) => {
      h.lines.forEach((l: string) => {
        if (l.startsWith('+')) addedTotal += 1
        else if (l.startsWith('-')) removedTotal += 1
      })
    })

    const r: Row[] = []
    let lineCount = 0
    let capped = false

    for (const h of hunks.slice(0, maxHunks)) {
      if (capped) break
      r.push({
        kind: 'hunkHeader',
        label: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      })
      let oldNo = h.oldStart
      let newNo = h.newStart
      for (const raw of h.lines as string[]) {
        if (lineCount >= MAX_EDIT_LINES) { capped = true; break }
        const marker = raw.charAt(0)
        const text = raw.slice(1)
        if (marker === '+') {
          r.push({ kind: 'add', newNo, text })
          newNo += 1
        } else if (marker === '-') {
          r.push({ kind: 'remove', oldNo, text })
          oldNo += 1
        } else {
          r.push({ kind: 'context', oldNo, newNo, text })
          oldNo += 1
          newNo += 1
        }
        lineCount += 1
      }
    }

    const hiddenCount = capped
      ? hunks.reduce((sum, h) => sum + h.lines.length, 0) - lineCount
      : 0

    return { rows: r, addedTotal, removedTotal, hiddenCount }
  }, [oldContent, newContent, filePath, isNewFile, contextLines, maxHunks])

  const gutterDigits = useMemo(() => {
    let max = 1
    for (const row of rows) {
      if (row.kind === 'add' && row.newNo > max) max = row.newNo
      else if (row.kind === 'remove' && row.oldNo > max) max = row.oldNo
      else if (row.kind === 'context' && row.newNo > max) max = row.newNo
    }
    return Math.max(2, String(max).length)
  }, [rows])

  const summary = useMemo(() => {
    const parts: string[] = []
    if (addedTotal > 0) parts.push(`Added ${addedTotal} line${addedTotal !== 1 ? 's' : ''}`)
    if (removedTotal > 0) parts.push(`${addedTotal > 0 ? 'r' : 'R'}emoved ${removedTotal} line${removedTotal !== 1 ? 's' : ''}`)
    return parts.join(', ')
  }, [addedTotal, removedTotal])

  return (
    <Box
      mt={2}
      mb={2}
      border="1px solid rgba(255,255,255,0.075)"
      borderRadius="10px"
      overflow="hidden"
      bg="rgba(0,0,0,0.28)"
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
        <Text
          fontSize="11px"
          color={tokens.colors.text.secondary}
          fontFamily={tokens.fontFamily.mono}
          fontWeight="600"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {filePath}
        </Text>
        {summary && (
          <Flex align="center" gap={1.5} flexShrink={0}>
            {addedTotal > 0 && (
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
                +{addedTotal}
              </Text>
            )}
            {removedTotal > 0 && (
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
                -{removedTotal}
              </Text>
            )}
          </Flex>
        )}
      </Flex>

      <Box
        overflow="hidden"
        fontFamily={tokens.fontFamily.mono}
        fontSize="12px"
        lineHeight="1.55"
        bg="rgba(0,0,0,0.18)"
      >
        {rows.map((row, i) => {
          if (row.kind === 'hunkHeader') {
            return (
              <Box
                key={`h-${i}`}
                px={2}
                py="2px"
                bg="rgba(255,255,255,0.025)"
                borderTop={i === 0 ? undefined : '1px solid rgba(255,255,255,0.05)'}
                borderBottom="1px solid rgba(255,255,255,0.05)"
              >
                <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
                  {row.label}
                </Text>
              </Box>
            )
          }

          const isAdd = row.kind === 'add'
          const isRemove = row.kind === 'remove'
          const bg = isAdd ? tokens.colors.diff.addedBg : isRemove ? tokens.colors.diff.removedBg : 'transparent'
          const fg = isAdd ? tokens.colors.diff.addedText : isRemove ? tokens.colors.diff.removedText : tokens.colors.text.secondary
          // ASCII '-' (not U+2212) so copy-as-diff stays valid for removed lines.
          const marker = isAdd ? '+' : isRemove ? '-' : ' '
          const lineNo = isRemove
            ? row.oldNo
            : isAdd
              ? row.newNo
              : row.newNo

          return (
            <Flex
              key={i}
              bg={bg}
              align="stretch"
              boxShadow={isAdd
                ? 'inset 2px 0 0 rgba(46, 160, 67, 0.52)'
                : isRemove
                  ? 'inset 2px 0 0 rgba(248, 81, 73, 0.52)'
                  : 'none'}
            >
              <Text
                w={`calc(${gutterDigits}ch + 0.75rem)`}
                pl={1}
                pr={1}
                color={tokens.colors.diff.lineNumber}
                fontFamily={tokens.fontFamily.mono}
                fontSize="11px"
                textAlign="right"
                whiteSpace="nowrap"
                userSelect="none"
                flexShrink={0}
                opacity={0.6}
              >
                {lineNo}
              </Text>
              <Text
                w="2ch"
                color={fg}
                fontWeight={isAdd || isRemove ? '700' : '400'}
                userSelect="none"
                flexShrink={0}
                textAlign="center"
              >
                {marker}
              </Text>
              <Text
                pr={2}
                color={fg}
                whiteSpace="pre-wrap"
                wordBreak="break-word"
                flex="1"
              >
                {row.text || ' '}
              </Text>
            </Flex>
          )
        })}
      </Box>

      {/* Hidden lines notice — only for new-file creates */}
      {hiddenCount > 0 && (
        <Flex align="center" gap={1.5} px={3} py="6px" borderTop="1px solid rgba(255,255,255,0.055)" bg="rgba(255,255,255,0.018)">
          <Text fontSize="11px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
            … +{hiddenCount} {hiddenCount === 1 ? 'line' : 'lines'}
          </Text>
        </Flex>
      )}
    </Box>
  )
})
