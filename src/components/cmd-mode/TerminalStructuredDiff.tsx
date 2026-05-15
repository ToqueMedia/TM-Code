import { memo, useMemo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { structuredPatch } from 'diff'
import { tokens } from '@/theme/tokens'

interface TerminalStructuredDiffProps {
  filePath: string
  oldContent: string
  newContent: string
  isNewFile?: boolean
  contextLines?: number
  maxHunks?: number
  /** Max visible code rows before truncation (default 20). */
  maxLines?: number
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
  maxLines = 20,
}: TerminalStructuredDiffProps) {
  const { rows, addedTotal, removedTotal, overflowCount } = useMemo(() => {
    // Normalize CRLF → LF so Windows files don't render with stray \r glyphs
    // and so the line counter matches what the user sees in the editor.
    const oldText = (oldContent ?? '').replace(/\r\n/g, '\n')
    const newText = (newContent ?? '').replace(/\r\n/g, '\n')

    if (isNewFile || oldText === '') {
      const lines = newText.split('\n')
      const capped = lines.slice(0, maxLines)
      const r: Row[] = []
      capped.forEach((line, i) => r.push({ kind: 'add', newNo: i + 1, text: line }))
      return { rows: r, addedTotal: lines.length, removedTotal: 0, overflowCount: Math.max(0, lines.length - maxLines) }
    }

    if (newText === '') {
      const lines = oldText.split('\n')
      const capped = lines.slice(0, maxLines)
      const r: Row[] = []
      capped.forEach((line, i) => r.push({ kind: 'remove', oldNo: i + 1, text: line }))
      return { rows: r, addedTotal: 0, removedTotal: lines.length, overflowCount: Math.max(0, lines.length - maxLines) }
    }

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
    let codeLineCount = 0
    let overflowCount = 0
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
        if (codeLineCount >= maxLines) {
          capped = true
          break
        }
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
        codeLineCount += 1
      }
    }

    if (capped) {
      const totalCodeLines = hunks.reduce((sum, h) => sum + h.lines.length, 0)
      overflowCount = totalCodeLines - codeLineCount
    }

    return { rows: r, addedTotal, removedTotal, overflowCount }
  }, [oldContent, newContent, filePath, isNewFile, contextLines, maxHunks, maxLines])

  const gutterDigits = useMemo(() => {
    let max = 1
    for (const row of rows) {
      if (row.kind === 'add' && row.newNo > max) max = row.newNo
      else if (row.kind === 'remove' && row.oldNo > max) max = row.oldNo
      else if (row.kind === 'context' && row.newNo > max) max = row.newNo
    }
    return Math.max(2, String(max).length)
  }, [rows])

  // Build summary like Claude Code: "Added 3 lines, removed 1 line"
  const summary = useMemo(() => {
    const parts: string[] = []
    if (addedTotal > 0) parts.push(`Added ${addedTotal} line${addedTotal !== 1 ? 's' : ''}`)
    if (removedTotal > 0) parts.push(`${addedTotal > 0 ? 'r' : 'R'}emoved ${removedTotal} line${removedTotal !== 1 ? 's' : ''}`)
    return parts.join(', ')
  }, [addedTotal, removedTotal])

  return (
    <Box mt="2px" mb={1}>
      {/* Summary line: └ Added X lines, removed Y lines */}
      {summary && (
        <Flex align="center" gap={1.5} mb="2px">
          <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} userSelect="none">└</Text>
          <Text fontSize="11px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
            {summary}
          </Text>
        </Flex>
      )}

      {/* Diff body */}
      <Box
        borderRadius="3px"
        overflow="hidden"
        border="1px solid rgba(255,255,255,0.06)"
        bg="rgba(255,255,255,0.015)"
        fontFamily={tokens.fontFamily.mono}
        fontSize="12px"
        lineHeight="1.5"
      >
        {rows.map((row, i) => {
          if (row.kind === 'hunkHeader') {
            return (
              <Box
                key={`h-${i}`}
                px={2}
                py="2px"
                bg="rgba(163,113,247,0.05)"
                borderTop={i === 0 ? undefined : '1px solid rgba(255,255,255,0.04)'}
                borderBottom="1px solid rgba(255,255,255,0.04)"
              >
                <Text fontSize="10px" color={tokens.colors.accent.purple} fontFamily={tokens.fontFamily.mono} letterSpacing="0.02em" opacity={0.7}>
                  {row.label}
                </Text>
              </Box>
            )
          }

          const isAdd = row.kind === 'add'
          const isRemove = row.kind === 'remove'
          const bg = isAdd ? tokens.colors.diff.addedBg : isRemove ? tokens.colors.diff.removedBg : 'transparent'
          const fg = isAdd ? tokens.colors.diff.addedText : isRemove ? tokens.colors.diff.removedText : tokens.colors.text.secondary
          const marker = isAdd ? '+' : isRemove ? '−' : ' '
          const lineNo = isRemove
            ? row.oldNo
            : isAdd
              ? row.newNo
              : row.newNo

          return (
            <Flex key={i} bg={bg} align="stretch">
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

        {/* Overflow indicator */}
        {overflowCount > 0 && (
          <Box px={2} py="3px" bg="rgba(255,255,255,0.02)" borderTop="1px solid rgba(255,255,255,0.04)">
            <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} fontStyle="italic">
              … {overflowCount} more line{overflowCount !== 1 ? 's' : ''}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )
})
