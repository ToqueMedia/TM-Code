import { memo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiCheck, FiX } from 'react-icons/fi'
import { diffLines } from 'diff'
import { DiffResult } from '../../services/agent/diffService'
import { tokens } from '@/theme/tokens'

interface DiffPreviewProps {
  diff: DiffResult
  onAccept: (diffId: string) => void
  onReject: (diffId: string) => void
}

function DiffPreview({ diff, onAccept, onReject }: DiffPreviewProps) {
  const fileName = diff.filePath.split('/').pop() || diff.filePath
  const changes = diff.isNewFile
    ? [{ value: diff.newContent, added: true, removed: false }]
    : diffLines(diff.originalContent, diff.newContent)

  return (
    <Box
      border={`1px solid ${tokens.colors.border.default}`}
      borderRadius="8px"
      overflow="hidden"
      mb={2}
      bg={tokens.colors.bg.codeBlock}
    >
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py={2}
        bg={tokens.colors.bg.sidebar}
        borderBottom={`1px solid ${tokens.colors.border.default}`}
      >
        <Flex align="center" gap={2}>
          <Text fontSize="12px">
            {diff.isNewFile ? '\u{1F7E2}' : '\u{1F7E1}'}
          </Text>
          <Text fontSize="xs" color={tokens.colors.text.primary} fontWeight="500">
            {diff.isNewFile ? 'New file' : 'Modified'}:
          </Text>
          <Text fontSize="xs" color={tokens.colors.accent.primary} fontFamily="mono">
            {fileName}
          </Text>
        </Flex>

        <Flex gap={1}>
          <button
            onClick={() => onReject(diff.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 10px',
              background: tokens.colors.accent.redSubtle,
              border: `1px solid ${tokens.colors.accent.redMuted}`,
              borderRadius: '4px',
              color: tokens.colors.accent.red,
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            <FiX size={12} /> Reject
          </button>
          <button
            onClick={() => onAccept(diff.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 10px',
              background: tokens.colors.accent.greenSubtle,
              border: `1px solid ${tokens.colors.accent.greenMuted}`,
              borderRadius: '4px',
              color: tokens.colors.accent.green,
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            <FiCheck size={12} /> Accept
          </button>
        </Flex>
      </Flex>

      {/* Diff content */}
      <Box
        maxH="300px"
        overflowY="auto"
        fontSize="12px"
        fontFamily={tokens.fontFamily.mono}
        lineHeight="20px"
      >
        {changes.map((change, i) => {
          const lines = change.value.replace(/\n$/, '').split('\n')
          return lines.map((line, j) => {
            let bg: string = 'transparent'
            let color: string = tokens.colors.text.primary
            let prefix = ' '

            if (change.added) {
              bg = tokens.colors.diff.addedBg
              color = tokens.colors.diff.addedText
              prefix = '+'
            } else if (change.removed) {
              bg = tokens.colors.diff.removedBg
              color = tokens.colors.diff.removedText
              prefix = '-'
            }

            return (
              <Box
                key={`${i}-${j}`}
                bg={bg}
                px={3}
                py={0}
                whiteSpace="pre"
                color={color}
              >
                <Text as="span" color={tokens.colors.diff.lineNumber} mr={2} userSelect="none">
                  {prefix}
                </Text>
                {line}
              </Box>
            )
          })
        })}
      </Box>

      {/* File path */}
      <Box px={3} py={1.5} bg={tokens.colors.bg.sidebar} borderTop={`1px solid ${tokens.colors.border.default}`}>
        <Text fontSize="10px" color={tokens.colors.diff.lineNumber} fontFamily="mono">
          {diff.filePath}
        </Text>
      </Box>
    </Box>
  )
}

export default memo(DiffPreview)
