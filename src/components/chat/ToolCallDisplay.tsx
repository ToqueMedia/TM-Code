import { memo, useState, useCallback, useMemo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import {
  FiFile, FiEdit2, FiFilePlus, FiFolder, FiSearch, FiTerminal,
  FiTrash2, FiGlobe, FiTool, FiChevronRight, FiChevronDown,
  FiCheck, FiX, FiLoader,
} from 'react-icons/fi'
import { ToolCallDisplay as ToolCallDisplayType } from '../../types/chat'
import InlineDiff from './InlineDiff'
import DiffService from '../../services/agent/diffService'
import { useChatStore } from '../../stores/chatStore'
import { tokens } from '@/theme/tokens'
import { detectLanguage, highlightLines } from '@/utils/syntaxHighlight'

interface ToolCallDisplayProps {
  toolCall: ToolCallDisplayType
  messageId: string
}

const TOOL_ICONS: Record<string, React.ComponentType<{ size?: number | string }>> = {
  read_file: FiFile,
  write_file: FiFilePlus,
  edit_file: FiEdit2,
  create_file: FiFilePlus,
  list_directory: FiFolder,
  search_files: FiSearch,
  glob: FiSearch,
  execute_command: FiTerminal,
  delete_file: FiTrash2,
  rename_file: FiEdit2,
  create_directory: FiFolder,
  web_fetch: FiGlobe,
}

function getInputSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file':
    case 'delete_file':
    case 'write_file':
    case 'create_file':
    case 'list_directory':
    case 'edit_file':
    case 'create_directory':
      return String(input.path || '')
    case 'search_files':
      return `"${input.query}" in ${input.directory}`
    case 'execute_command':
      return String(input.command || '')
    case 'rename_file':
      return `${input.oldPath} \u2192 ${input.newName}`
    case 'glob':
      return String(input.pattern || '')
    case 'web_fetch':
      return String(input.url || '')
    default:
      return JSON.stringify(input)
  }
}

function isWriteTool(toolName: string): boolean {
  return toolName === 'write_file' || toolName === 'edit_file' || toolName === 'create_file'
}

function ToolCallDisplayComponent({ toolCall, messageId }: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false)
  const IconComponent = TOOL_ICONS[toolCall.toolName] || FiTool
  const inputSummary = getInputSummary(toolCall.toolName, toolCall.input)
  const isRunning = toolCall.status === 'running'
  const isFailed = toolCall.status === 'failed'
  const isCompleted = toolCall.status === 'completed'

  const hasDiff = toolCall.diffNewContent !== undefined && isWriteTool(toolCall.toolName)

  // Result text (moved before hooks to avoid conditional hook calls)
  const resultText = toolCall.result || ''

  // Syntax-highlight read_file output
  const readFileLang = toolCall.toolName === 'read_file' ? detectLanguage(String(toolCall.input.path || '')) : null
  const highlightedOutput = useMemo(() => {
    if (!readFileLang || !resultText) return null
    return highlightLines(resultText, readFileLang)
  }, [readFileLang, resultText])

  const handleApprove = useCallback(async () => {
    const chatStore = useChatStore.getState()
    if (toolCall.diffResultId) {
      await DiffService.getInstance().acceptDiff(toolCall.diffResultId)
      chatStore.removePendingDiff(toolCall.diffResultId)
    }
    chatStore.updateToolCallDiffStatus(messageId, toolCall.id, 'approved')
  }, [toolCall.diffResultId, toolCall.id, messageId])

  const handleApproveAll = useCallback(async () => {
    await useChatStore.getState().approveAllPendingDiffs()
  }, [])

  const handleDeny = useCallback(() => {
    const chatStore = useChatStore.getState()
    if (toolCall.diffResultId) {
      DiffService.getInstance().rejectDiff(toolCall.diffResultId)
      chatStore.removePendingDiff(toolCall.diffResultId)
    }
    chatStore.updateToolCallDiffStatus(messageId, toolCall.id, 'denied')
  }, [toolCall.diffResultId, toolCall.id, messageId])

  // Render inline diff for write tools
  if (isCompleted && hasDiff) {
    return (
      <Box my={2}>
        <Flex align="center" gap={2} mb={1.5} px={1}>
          <Box color={tokens.colors.accent.green} flexShrink={0}>
            <FiCheck size={12} />
          </Box>
          <Box color={tokens.colors.text.muted} flexShrink={0}>
            <IconComponent size={13} />
          </Box>
          <Text
            color={tokens.colors.text.secondary}
            fontFamily={tokens.fontFamily.mono}
            fontSize="12px"
          >
            {toolCall.toolName}
          </Text>
          <Text
            color={tokens.colors.text.disabled}
            fontSize="11px"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            flex="1"
            fontFamily={tokens.fontFamily.mono}
          >
            {inputSummary}
          </Text>
        </Flex>
        <InlineDiff
          filePath={toolCall.input.path as string}
          oldContent={toolCall.diffOldContent || ''}
          newContent={toolCall.diffNewContent || ''}
          isNewFile={toolCall.isNewFile || false}
          status={toolCall.diffStatus || 'pending'}
          onApprove={handleApprove}
          onApproveAll={handleApproveAll}
          onDeny={handleDeny}
        />
      </Box>
    )
  }

  // Standard tool call rendering
  const resultLines = resultText.split('\n')
  const hasOutput = resultText.length > 0 && !isRunning
  const showExpand = resultLines.length > 4 && !expanded
  const displayResult = showExpand ? resultLines.slice(0, 4).join('\n') : resultText

  return (
    <Box
      borderRadius="8px"
      overflow="hidden"
      my={1.5}
      border={`1px solid ${isRunning ? 'rgba(240, 192, 0, 0.12)' : isFailed ? 'rgba(248, 81, 73, 0.12)' : 'rgba(255, 255, 255, 0.04)'}`}
      bg={isRunning ? 'rgba(240, 192, 0, 0.03)' : isFailed ? 'rgba(248, 81, 73, 0.03)' : 'rgba(255, 255, 255, 0.015)'}
      transition="all 0.15s"
    >
      {/* Header row */}
      <Flex
        align="center"
        gap={2}
        px={3}
        py="8px"
        cursor={hasOutput ? 'pointer' : 'default'}
        _hover={hasOutput ? { bg: 'rgba(255, 255, 255, 0.02)' } : undefined}
        transition="background 0.1s"
        onClick={() => { if (hasOutput) setExpanded(!expanded) }}
      >
        {/* Status indicator */}
        {isRunning ? (
          <Box
            color={tokens.colors.toolCall.runningText}
            flexShrink={0}
            animation="toolSpin 1s linear infinite"
            css={{
              '@keyframes toolSpin': {
                from: { transform: 'rotate(0deg)' },
                to: { transform: 'rotate(360deg)' },
              },
            }}
          >
            <FiLoader size={12} />
          </Box>
        ) : isFailed ? (
          <Box color={tokens.colors.accent.red} flexShrink={0}>
            <FiX size={12} />
          </Box>
        ) : (
          <Box color={tokens.colors.accent.green} flexShrink={0}>
            <FiCheck size={12} />
          </Box>
        )}

        {/* Tool icon */}
        <Box color={tokens.colors.text.muted} flexShrink={0}>
          <IconComponent size={13} />
        </Box>

        {/* Tool name */}
        <Text
          color={tokens.colors.text.secondary}
          fontFamily={tokens.fontFamily.mono}
          fontSize="12px"
          flexShrink={0}
          fontWeight="500"
        >
          {toolCall.toolName}
        </Text>

        {/* Summary */}
        <Text
          color={tokens.colors.text.disabled}
          fontSize="11px"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          flex="1"
          fontFamily={tokens.fontFamily.mono}
        >
          {inputSummary}
        </Text>

        {/* Expand chevron */}
        {hasOutput && (
          <Box color={tokens.colors.text.disabled} flexShrink={0} transition="transform 0.15s">
            {expanded ? <FiChevronDown size={13} /> : <FiChevronRight size={13} />}
          </Box>
        )}
      </Flex>

      {/* Running progress bar */}
      {isRunning && (
        <Box h="1.5px" overflow="hidden" bg="rgba(240, 192, 0, 0.08)">
          <Box
            h="100%"
            bg={tokens.colors.toolCall.runningText}
            opacity={0.5}
            animation="toolProgress 1.8s ease-in-out infinite"
            css={{
              '@keyframes toolProgress': {
                '0%': { transform: 'translateX(-100%)', width: '40%' },
                '50%': { transform: 'translateX(150%)', width: '40%' },
                '100%': { transform: 'translateX(-100%)', width: '40%' },
              },
            }}
          />
        </Box>
      )}

      {/* Expanded output */}
      {expanded && hasOutput && (
        <Box
          px={3}
          py="10px"
          borderTop={`1px solid rgba(255, 255, 255, 0.04)`}
          bg={highlightedOutput ? tokens.colors.bg.codeBlock : 'rgba(0, 0, 0, 0.12)'}
          maxH="220px"
          overflowY="auto"
          overflowX="auto"
          css={{
            '&::-webkit-scrollbar': { width: '4px', height: '4px' },
            '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.1)', borderRadius: '2px' },
          }}
        >
          {highlightedOutput ? (
            <>
              {(showExpand ? highlightedOutput.slice(0, 4) : highlightedOutput).map((lineTokens, li) => (
                <Flex key={li} align="center" minH="18px">
                  <Text
                    w="36px"
                    flexShrink={0}
                    textAlign="right"
                    pr="10px"
                    fontSize="10px"
                    color="rgba(255,255,255,0.18)"
                    userSelect="none"
                    fontFamily={tokens.fontFamily.mono}
                  >
                    {li + 1}
                  </Text>
                  <Box
                    flex="1"
                    whiteSpace="pre"
                    fontSize="11px"
                    fontFamily={tokens.fontFamily.mono}
                    lineHeight="18px"
                  >
                    {lineTokens.map((token, ti) => (
                      <span key={ti} style={{ color: token.color }}>
                        {token.text}
                      </span>
                    ))}
                  </Box>
                </Flex>
              ))}
            </>
          ) : (
            <Text
              fontSize="11px"
              fontFamily={tokens.fontFamily.mono}
              color={isFailed ? tokens.colors.accent.red : tokens.colors.text.muted}
              whiteSpace="pre-wrap"
              wordBreak="break-all"
              lineHeight="1.55"
            >
              {displayResult}
            </Text>
          )}
          {showExpand && (
            <Text
              fontSize="10px"
              color={tokens.colors.accent.primary}
              mt={1.5}
              cursor="pointer"
              _hover={{ textDecoration: 'underline' }}
              onClick={(e) => { e.stopPropagation(); setExpanded(true) }}
            >
              Show {resultLines.length - 4} more lines
            </Text>
          )}
        </Box>
      )}
    </Box>
  )
}

export default memo(ToolCallDisplayComponent)
