import { memo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { ToolCallDisplay as ToolCallDisplayType } from '../../types/chat'
import { tokens } from '@/theme/tokens'

interface ToolCallDisplayProps {
  toolCall: ToolCallDisplayType
}

const TOOL_ICONS: Record<string, string> = {
  read_file: '\u{1F4C4}',
  write_file: '\u{1F4DD}',
  create_file: '\u{1F4DD}',
  list_directory: '\u{1F4C1}',
  search_files: '\u{1F50D}',
  execute_command: '\u{26A1}',
  delete_file: '\u{1F5D1}',
  rename_file: '\u{270F}\u{FE0F}',
  create_directory: '\u{1F4C1}',
}

function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] || '\u{1F527}'
}

function getInputSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file':
    case 'delete_file':
      return String(input.path || '')
    case 'write_file':
    case 'create_file':
      return String(input.path || '')
    case 'list_directory':
      return String(input.path || '')
    case 'search_files':
      return `"${input.query}" in ${input.directory}`
    case 'execute_command':
      return String(input.command || '')
    case 'rename_file':
      return `${input.oldPath} -> ${input.newName}`
    case 'create_directory':
      return String(input.path || '')
    default:
      return JSON.stringify(input)
  }
}

function getResultSummary(toolName: string, result: string): string {
  if (toolName === 'write_file' || toolName === 'create_file') {
    return result
  }
  return result
}

function ToolCallDisplayComponent({ toolCall }: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false)
  const icon = getToolIcon(toolCall.toolName)
  const inputSummary = getInputSummary(toolCall.toolName, toolCall.input)
  const isRunning = toolCall.status === 'running'
  const isFailed = toolCall.status === 'failed'

  const bgColor = isRunning
    ? tokens.colors.toolCall.runningBg
    : isFailed
    ? tokens.colors.toolCall.failedBg
    : tokens.colors.toolCall.successBg

  const borderColor = isRunning
    ? tokens.colors.toolCall.runningBorder
    : isFailed
    ? tokens.colors.toolCall.failedBorder
    : tokens.colors.toolCall.successBorder

  const statusIcon = isRunning ? '\u{23F3}' : isFailed ? '\u{274C}' : '\u{2705}'

  const resultText = toolCall.result ? getResultSummary(toolCall.toolName, toolCall.result) : ''
  const resultLines = resultText.split('\n')
  const showExpand = resultLines.length > 3 && !expanded
  const displayResult = showExpand ? resultLines.slice(0, 3).join('\n') + '...' : resultText

  return (
    <Box
      bg={bgColor}
      border="1px solid"
      borderColor={borderColor}
      borderRadius="6px"
      px={3}
      py={2}
      my={2}
      fontSize="12px"
      cursor={resultLines.length > 3 ? 'pointer' : 'default'}
      onClick={() => {
        if (resultLines.length > 3) setExpanded(!expanded)
      }}
    >
      <Flex align="center" gap={2}>
        <Text fontSize="14px" flexShrink={0}>{icon}</Text>
        <Text color={tokens.colors.text.primary} fontWeight="500" fontFamily="mono" fontSize="12px">
          {toolCall.toolName}
        </Text>
        <Text color={tokens.colors.text.subtle} fontSize="11px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" flex="1">
          {inputSummary}
        </Text>
      </Flex>

      {(toolCall.status !== 'running' && toolCall.result) && (
        <Flex align="flex-start" gap={2} mt={1.5}>
          <Text fontSize="12px" flexShrink={0}>{statusIcon}</Text>
          <Text
            color={isFailed ? tokens.colors.accent.red : tokens.colors.text.secondary}
            fontSize="11px"
            fontFamily="mono"
            whiteSpace="pre-wrap"
            wordBreak="break-all"
          >
            {displayResult}
          </Text>
        </Flex>
      )}

      {isRunning && (
        <Flex align="center" gap={2} mt={1.5}>
          <Text fontSize="12px">{statusIcon}</Text>
          <Text color={tokens.colors.toolCall.runningText} fontSize="11px">Running...</Text>
        </Flex>
      )}

      {showExpand && (
        <Text color={tokens.colors.accent.primary} fontSize="10px" mt={1} textAlign="right">
          Click to expand
        </Text>
      )}
    </Box>
  )
}

export default memo(ToolCallDisplayComponent)
