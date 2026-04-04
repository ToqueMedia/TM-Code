import { memo, useState, useCallback, useMemo } from 'react'
import { Box, Flex, Text, Image } from '@chakra-ui/react'
import {
  FiFolder, FiSearch, FiTerminal,
  FiGlobe, FiTool, FiChevronRight, FiChevronDown,
  FiCheck, FiX, FiLoader, FiCpu,
} from 'react-icons/fi'
import { ToolCallDisplay as ToolCallDisplayType } from '../../types/chat'
import InlineDiff from './InlineDiff'
import { useChatStore } from '../../stores/chatStore'
import { getFileIconUrl } from '@/utils/fileIcons'
import { tokens } from '@/theme/tokens'
import { detectLanguage, highlightLines } from '@/utils/syntaxHighlight'

interface ToolCallDisplayProps {
  toolCall: ToolCallDisplayType
  messageId: string
}

const TOOL_ICONS: Record<string, React.ComponentType<{ size?: number | string }>> = {
  list_directory: FiFolder,
  search_files: FiSearch,
  glob: FiSearch,
  execute_command: FiTerminal,
  create_directory: FiFolder,
  web_fetch: FiGlobe,
  research: FiCpu,
  spawn_background_agent: FiCpu,
  check_background_agents: FiSearch,
}

/** Tools where we show a file-extension icon instead of the generic tool icon. */
const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'create_file', 'delete_file', 'rename_file'])

/** Human-readable tool labels shown in the chat UI. */
const TOOL_LABELS: Record<string, string> = {
  read_file: 'Reading',
  write_file: 'Writing',
  create_file: 'Creating',
  edit_file: 'Editing',
  delete_file: 'Deleting',
  rename_file: 'Renaming',
  list_directory: 'Exploring',
  create_directory: 'Creating folder',
  search_files: 'Searching',
  glob: 'Finding files',
  execute_command: 'Running',
  start_dev_server: 'Starting server',
  get_diagnostics: 'Checking types',
  read_dev_server_logs: 'Reading server logs',
  read_large_result: 'Reading output',
  web_fetch: 'Fetching',
  research: 'Researching',
  spawn_background_agent: 'Background task',
  check_background_agents: 'Checking agents',
  verify: 'Verifying',
  update_tasks: 'Updating tasks',
  request_thinking: 'Activating reasoning',
}

function getToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] || toolName
}

function getInputSummary(toolName: string, input: Record<string, unknown>): string {
  const fileName = (p: string) => p.split('/').pop() || p

  switch (toolName) {
    case 'read_file':
      return fileName(String(input.path || ''))
    case 'write_file':
    case 'create_file':
      return fileName(String(input.path || ''))
    case 'edit_file':
      return fileName(String(input.path || ''))
    case 'delete_file':
      return fileName(String(input.path || ''))
    case 'rename_file':
      return `${fileName(String(input.oldPath || ''))} → ${input.newName}`
    case 'list_directory':
      return fileName(String(input.path || '')) || 'project'
    case 'create_directory':
      return fileName(String(input.path || ''))
    case 'search_files':
      return `"${input.query}"`
    case 'execute_command': {
      const cmd = String(input.command || '')
      return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
    }
    case 'start_dev_server': {
      const type = input.server_type === 'backend' ? 'backend' : 'frontend'
      return `${type} server`
    }
    case 'get_diagnostics':
      return fileName(String(input.path || ''))
    case 'read_dev_server_logs':
      return `last ${input.lines || 50} lines`
    case 'glob':
      return String(input.pattern || '')
    case 'web_fetch':
      return String(input.url || '').replace(/^https?:\/\//, '').slice(0, 50)
    case 'research':
    case 'spawn_background_agent': {
      const q = String(input.question || '')
      return q.length > 50 ? q.slice(0, 47) + '...' : q
    }
    case 'check_background_agents':
      return ''
    case 'verify': {
      const desc = String(input.task_description || '')
      return desc.length > 50 ? desc.slice(0, 47) + '...' : desc
    }
    case 'update_tasks': {
      const tasks = input.tasks as Array<{ status: string }> | undefined
      if (tasks) {
        const done = tasks.filter(t => t.status === 'completed').length
        return `${done}/${tasks.length} completed`
      }
      return ''
    }
    case 'request_thinking':
      return 'deep reasoning mode'
    default: {
      // MCP tools: show just the tool name part
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__')
        return parts[2] || toolName
      }
      return JSON.stringify(input).slice(0, 50)
    }
  }
}

function isWriteTool(toolName: string): boolean {
  return toolName === 'write_file' || toolName === 'edit_file' || toolName === 'create_file'
}

function ToolCallDisplayComponent({ toolCall, messageId }: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false)
  const filePath = (toolCall.input?.path || toolCall.input?.oldPath || '') as string
  const useFileIcon = FILE_TOOLS.has(toolCall.toolName) && !!filePath
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

  const handleApprove = useCallback(() => {
    useChatStore.getState().approveDiff(messageId, toolCall.id, toolCall.diffResultId)
  }, [messageId, toolCall.id, toolCall.diffResultId])

  const handleApproveAll = useCallback(() => {
    useChatStore.getState().approveAllPendingDiffs()
  }, [])

  const handleDeny = useCallback(() => {
    useChatStore.getState().rejectDiff(messageId, toolCall.id, toolCall.diffResultId)
  }, [messageId, toolCall.id, toolCall.diffResultId])

  const handleRejectAll = useCallback(() => {
    useChatStore.getState().rejectAllAndStop()
  }, [])

  // Render inline diff for write tools
  if (isCompleted && hasDiff) {
    return (
      <Box my={2}>
        <Flex align="center" gap={2} mb={1.5} px={1}>
          <Box color={tokens.colors.accent.green} flexShrink={0}>
            <FiCheck size={12} />
          </Box>
          {useFileIcon ? (
            <Image src={getFileIconUrl(filePath)} w="14px" h="14px" flexShrink={0} />
          ) : (
            <Box color={tokens.colors.text.muted} flexShrink={0}>
              <IconComponent size={13} />
            </Box>
          )}
          <Text
            color={tokens.colors.text.secondary}
            fontFamily={tokens.fontFamily.mono}
            fontSize="12px"
          >
            {getToolLabel(toolCall.toolName)}
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
          onRejectAll={handleRejectAll}
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
            css={{
              animation: 'toolSpin 1s linear infinite',
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
        {useFileIcon ? (
          <Image src={getFileIconUrl(filePath)} w="14px" h="14px" flexShrink={0} />
        ) : (
          <Box color={tokens.colors.text.muted} flexShrink={0}>
            <IconComponent size={13} />
          </Box>
        )}

        {/* Tool name */}
        <Text
          color={tokens.colors.text.secondary}
          fontFamily={tokens.fontFamily.mono}
          fontSize="12px"
          flexShrink={0}
          fontWeight="500"
        >
          {getToolLabel(toolCall.toolName)}
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

      {/* Running: progress bar + live status for sub-agents */}
      {isRunning && (
        <>
          {toolCall.progressText && (
            <Flex px={3} py="5px" gap={2} align="center" borderTop="1px solid rgba(255,255,255,0.03)">
              <Box
                w="4px"
                h="4px"
                borderRadius="full"
                bg={tokens.colors.accent.purple}
                flexShrink={0}
                css={{
                  animation: 'subAgentPulse 1s ease-in-out infinite',
                  '@keyframes subAgentPulse': {
                    '0%, 100%': { opacity: 1 },
                    '50%': { opacity: 0.3 },
                  },
                }}
              />
              <Text
                fontSize="11px"
                color={tokens.colors.text.muted}
                fontFamily={tokens.fontFamily.mono}
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
              >
                {toolCall.progressText}
              </Text>
            </Flex>
          )}
          <Box h="1.5px" overflow="hidden" bg="rgba(240, 192, 0, 0.08)">
            <Box
              h="100%"
              bg={tokens.colors.toolCall.runningText}
              opacity={0.5}
              css={{
                animation: 'toolProgress 1.8s ease-in-out infinite',
                '@keyframes toolProgress': {
                  '0%': { transform: 'translateX(-100%)', width: '40%' },
                  '50%': { transform: 'translateX(150%)', width: '40%' },
                  '100%': { transform: 'translateX(-100%)', width: '40%' },
                },
              }}
            />
          </Box>
        </>
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
                <Flex key={`tcl-${li}-${lineTokens[0]?.text?.slice(0, 16) ?? ''}`} align="center" minH="18px">
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
