import { memo, useMemo } from 'react'
import { Box, Flex, Text, Image } from '@chakra-ui/react'
import type { ToolCallDisplay } from '../../types/chat'
import { tokens } from '@/theme/tokens'
import { TerminalStructuredDiff } from './TerminalStructuredDiff'
import { getToolDisplay, getToolSubtitle, shortenPath } from './toolDisplay'

interface TerminalToolCallProps {
  toolCall: ToolCallDisplay
}

const READ_TOOLS = new Set([
  'read_file',
  'list_directory',
  'glob',
  'search_files',
  'read_large_result',
  'read_dev_server_logs',
  'check_background_agents',
])

// Tools that mutate the filesystem — shown with their own running hint so
// the user sees *something* while the write is in flight, instead of a
// lone spinner with an empty body.
const WRITE_TOOLS = new Set([
  'write_file',
  'create_file',
  'edit_file',
  'delete_file',
  'rename_file',
  'create_directory',
])

// Sub-agent spawners emit their output INLINE via the text-delta stream + nested
// child tool calls. Their `result` field duplicates that stream content, so we
// suppress the result box on the parent launcher to avoid showing the same
// text twice.
const SUBAGENT_SPAWNERS = new Set([
  'research',
  'verify',
  'spawn_background_agent',
])

const RESULT_PREVIEW_CHARS = 1400

// Detect base64-encoded images in tool results (browser_take_screenshot, etc.)
// Returns the data URI if the result is a valid image, null otherwise.
function extractImageSrc(result: string): string | null {
  if (!result) return null
  // Already a data URI
  if (result.startsWith('data:image/')) return result
  // Raw base64 that looks like image data (PNG starts with iVBOR, JPEG with /9j/)
  const trimmed = result.trim()
  if (/^(?:iVBOR[A-Za-z0-9+/=]{100,}|\/9j\/[A-Za-z0-9+/=]{100,})/.test(trimmed)) {
    const mime = trimmed.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${trimmed}`
  }
  return null
}

function buildReadSummary(toolName: string, result: string | undefined): string | null {
  if (!result) return null
  if (toolName === 'read_file') {
    const lines = result.split('\n').length
    return `${lines} line${lines !== 1 ? 's' : ''}`
  }
  if (toolName === 'list_directory') {
    const entries = result.split('\n').filter(Boolean).length
    return `${entries} entr${entries !== 1 ? 'ies' : 'y'}`
  }
  if (toolName === 'search_files' || toolName === 'glob') {
    const matches = result.split('\n').filter(Boolean).length
    return `${matches} result${matches !== 1 ? 's' : ''}`
  }
  return null
}

export const TerminalToolCall = memo(function TerminalToolCall({ toolCall }: TerminalToolCallProps) {
  const isError = toolCall.isError || toolCall.status === 'failed'
  const isRunning = toolCall.status === 'running'
  const hasDiff = toolCall.diffOldContent !== undefined || toolCall.diffNewContent !== undefined
  const isReadTool = READ_TOOLS.has(toolCall.toolName)
  const isWriteTool = WRITE_TOOLS.has(toolCall.toolName)

  const display = getToolDisplay(toolCall.toolName)
  const verb = isRunning ? display.running : isError ? display.failed : display.done
  const subtitle = useMemo(
    () => getToolSubtitle(toolCall.toolName, toolCall.input),
    [toolCall.toolName, toolCall.input],
  )

  const filePath = typeof toolCall.input?.file_path === 'string'
    ? (toolCall.input.file_path as string)
    : typeof toolCall.input?.path === 'string'
      ? (toolCall.input.path as string)
      : null

  const statusColor = isRunning
    ? tokens.colors.toolCall.runningText
    : isError
      ? tokens.colors.accent.red
      : tokens.colors.accent.green

  const readSummary = useMemo(
    () => isReadTool && !isRunning ? buildReadSummary(toolCall.toolName, toolCall.result) : null,
    [isReadTool, isRunning, toolCall.toolName, toolCall.result],
  )

  const isSubAgentSpawner = SUBAGENT_SPAWNERS.has(toolCall.toolName)
  const showResult = toolCall.result && !hasDiff && !isReadTool && !isSubAgentSpawner

  const isNested = !!toolCall.spawnedBy

  return (
    <Box
      my={1.5}
      fontFamily={tokens.fontFamily.mono}
      {...(isNested
        ? {
            // Visual marker: nested sub-agent tool calls are indented and carry
            // a purple left-rail so the user sees at a glance what was run by
            // a research/verify sub-agent vs the main agent.
            ml: 4,
            pl: 2,
            borderLeft: `2px solid ${tokens.colors.accent.purple}`,
            opacity: 0.95,
          }
        : {})}
    >
      {/* Header: ● Verb(path)  or  ● Verb subtitle */}
      <Flex align="center" gap={1.5} wrap="wrap">
        {isNested && (
          <Text
            fontSize="10px"
            fontWeight="700"
            color={tokens.colors.accent.purple}
            flexShrink={0}
            lineHeight="1"
            opacity={0.7}
            title="Sub-agent tool call"
          >
            ↳
          </Text>
        )}
        <Text
          fontSize="11px"
          fontWeight="700"
          color={statusColor}
          flexShrink={0}
          lineHeight="1"
          css={
            isRunning
              ? {
                  display: 'inline-block',
                  animation: 'toolSpin 1.1s linear infinite',
                  '@keyframes toolSpin': {
                    '0%': { transform: 'rotate(0deg)' },
                    '100%': { transform: 'rotate(360deg)' },
                  },
                }
              : undefined
          }
        >
          {isRunning ? '⟳' : '●'}
        </Text>

        <Text
          fontSize="13px"
          fontWeight="600"
          color={tokens.colors.terminal.foreground}
          flexShrink={0}
        >
          {verb}
          {subtitle && (
            <Text as="span" color={tokens.colors.text.muted} fontWeight="400">
              ({subtitle.length > 70 ? shortenPath(subtitle) : subtitle})
            </Text>
          )}
        </Text>

        {toolCall.isNewFile && (
          <Text
            fontSize="9px"
            color={tokens.colors.accent.green}
            border="1px solid"
            borderColor="rgba(46,160,67,0.35)"
            px="5px"
            py="0px"
            borderRadius="3px"
            fontWeight="700"
            letterSpacing="0.08em"
          >
            NEW
          </Text>
        )}
      </Flex>

      {/* Body — indented connector */}
      <Box
        pl={4}
        mt="1px"
        borderLeft={`1px solid ${
          isError ? 'rgba(248,81,73,0.18)'
          : isRunning ? 'rgba(240,192,0,0.18)'
          : 'rgba(255,255,255,0.05)'
        }`}
      >
        {/* Read tool: compact summary when done, running hint while waiting.
            Without the running hint, search_files / glob tools appear as a lone
            spinner with no body — users can't tell if the query is slow, stuck,
            or genuinely finding nothing. */}
        {isReadTool && !isRunning && readSummary && (
          <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} mt="1px">
            {readSummary}
          </Text>
        )}
        {isReadTool && isRunning && !toolCall.progressText && (
          <Text fontSize="11px" color={tokens.colors.toolCall.runningText} fontFamily={tokens.fontFamily.mono} mt="1px" opacity={0.8}>
            working…
          </Text>
        )}

        {/* Write tools: running hint while the disk write is in flight.
            Otherwise write_file / edit_file / create_file render as a
            lone spinner with an empty body until the result comes back. */}
        {isWriteTool && isRunning && !hasDiff && !toolCall.progressText && (
          <Text fontSize="11px" color={tokens.colors.toolCall.runningText} fontFamily={tokens.fontFamily.mono} mt="1px" opacity={0.8}>
            writing…
          </Text>
        )}

        {/* Structured diff for write/edit tools */}
        {hasDiff && (
          <TerminalStructuredDiff
            filePath={filePath || 'file'}
            oldContent={toolCall.diffOldContent || ''}
            newContent={toolCall.diffNewContent || ''}
            isNewFile={toolCall.isNewFile}
          />
        )}

        {/* Tool result for non-read, non-diff tools (execute_command, etc.) */}
        {showResult && (() => {
          const imgSrc = extractImageSrc(toolCall.result!)
          if (imgSrc) {
            return (
              <Box mt="3px" borderRadius="4px" overflow="hidden" maxW="480px">
                <Image
                  src={imgSrc}
                  alt="Screenshot"
                  w="100%"
                  borderRadius="4px"
                  border="1px solid rgba(255,255,255,0.06)"
                />
              </Box>
            )
          }
          return (
            <Box
              mt="3px"
              px={2}
              py="4px"
              borderRadius="3px"
              bg={isError ? 'rgba(248,81,73,0.04)' : 'rgba(255,255,255,0.015)'}
              border={`1px solid ${isError ? 'rgba(248,81,73,0.12)' : 'rgba(255,255,255,0.04)'}`}
            >
              <Text
                fontSize="12px"
                color={isError ? tokens.colors.accent.red : tokens.colors.text.secondary}
                whiteSpace="pre-wrap"
                lineHeight="1.5"
                fontFamily={tokens.fontFamily.mono}
              >
                {toolCall.result!.length > RESULT_PREVIEW_CHARS
                  ? toolCall.result!.slice(0, RESULT_PREVIEW_CHARS)
                  : toolCall.result}
              </Text>
              {toolCall.result!.length > RESULT_PREVIEW_CHARS && (
                <Text
                  mt="2px"
                  fontSize="10px"
                  color={tokens.colors.text.disabled}
                  fontFamily={tokens.fontFamily.mono}
                  fontStyle="italic"
                >
                  … {toolCall.result!.length - RESULT_PREVIEW_CHARS} more chars
                </Text>
              )}
            </Box>
          )
        })()}

        {/* Error result for read tools — still show the error */}
        {isReadTool && isError && toolCall.result && (
          <Text
            fontSize="11px"
            color={tokens.colors.accent.red}
            fontFamily={tokens.fontFamily.mono}
            mt="2px"
          >
            {toolCall.result.slice(0, 200)}
          </Text>
        )}

        {/* Live progress */}
        {toolCall.progressText && (
          <Flex align="center" gap={1.5} mt="3px">
            <Box
              w="6px"
              h="6px"
              borderRadius="full"
              bg={tokens.colors.toolCall.runningText}
              css={{
                animation: 'toolProgressPulse 1.4s ease-in-out infinite',
                '@keyframes toolProgressPulse': {
                  '0%, 100%': { opacity: 0.35, transform: 'scale(0.9)' },
                  '50%': { opacity: 1, transform: 'scale(1.1)' },
                },
              }}
            />
            <Text fontSize="11px" color={tokens.colors.toolCall.runningText} fontFamily={tokens.fontFamily.mono}>
              {toolCall.progressText}
            </Text>
          </Flex>
        )}
      </Box>
    </Box>
  )
})
