import { memo, useMemo } from 'react'
import { Box, Flex, Text, Image } from '@chakra-ui/react'
import type { ToolCallDisplay } from '../../types/chat'
import { tokens } from '@/theme/tokens'
import { TerminalStructuredDiff } from './TerminalStructuredDiff'
import { getToolDisplay, getToolSubtitle, shortenPath } from './toolDisplay'
import { isShellTool, ShellCommandBlock } from '../shell/ShellCommandBlock'
import { Spinner } from './terminalSpinner'
import { t } from '@/i18n'

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

function buildReadSummary(
  toolName: string,
  result: string | undefined,
  input?: Record<string, unknown>,
): string | null {
  if (!result) return null
  if (toolName === 'read_file') {
    const lines = result.split('\n').length
    // Leitura paginada (offset/limit): mostrar o INTERVALO em vez da
    // contagem — com o colapso de reads consecutivos do mesmo ficheiro,
    // a linha única lê-se "lines 101–200" e vai-se substituindo a cada
    // chamada, como o user pediu (2026-06-12).
    const offset = typeof input?.offset === 'number' && input.offset >= 1 ? Math.floor(input.offset) : null
    if (offset !== null) {
      return `lines ${offset}–${offset + lines - 1}`
    }
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

function buildTaskCompletionSummary(result: string | undefined, input: Record<string, unknown> | undefined): string | null {
  if (result) {
    const match = result.match(/Task list updated:\s*(\d+)\/(\d+)\s+completed\./)
    if (match) return `${match[1]}/${match[2]}`
  }

  const tasks = input?.tasks
  if (!Array.isArray(tasks)) return null

  const completed = tasks.filter((task) => {
    if (!task || typeof task !== 'object') return false
    return (task as { status?: unknown }).status === 'completed'
  }).length
  return `${completed}/${tasks.length}`
}

function buildTaskListPreview(result: string | undefined): string | null {
  if (!result) return null
  if (!result.includes('Active tasks:') && !result.includes('New task list:')) return null
  return result.split('\n').slice(1).join('\n').trim() || null
}

export const TerminalToolCall = memo(function TerminalToolCall({ toolCall }: TerminalToolCallProps) {
  const isError = toolCall.isError || toolCall.status === 'failed'
  // `started` (set on onToolCallStart) separates the call actually executing
  // from those streamed-in but still QUEUED behind a pending diff approval —
  // the serial tool loop runs edits one at a time. Without it, every queued
  // edit shows an active spinner and reads as parallel edits firing at once.
  const isQueued = toolCall.status === 'running' && toolCall.started !== true
  const isRunning = toolCall.status === 'running' && toolCall.started === true
  const hasDiff = toolCall.diffOldContent !== undefined || toolCall.diffNewContent !== undefined
  const isReadTool = READ_TOOLS.has(toolCall.toolName)
  const isWriteTool = WRITE_TOOLS.has(toolCall.toolName)
  const isNested = !!toolCall.spawnedBy

  if (isShellTool(toolCall.toolName)) {
    return (
      <ShellCommandBlock
        toolCall={toolCall}
        mode="terminal"
        nested={isNested}
      />
    )
  }

  const display = getToolDisplay(toolCall.toolName)
  const verb = isQueued
    ? `${t('toolLabel.queued')} · ${display.running}`
    : isRunning ? display.running : isError ? display.failed : display.done
  const taskCompletionSummary = toolCall.toolName === 'update_tasks'
    ? buildTaskCompletionSummary(toolCall.result, toolCall.input)
    : null
  const subtitle = useMemo(
    () => getToolSubtitle(toolCall.toolName, toolCall.input),
    [toolCall.toolName, toolCall.input],
  )
  const headerSubtitle = taskCompletionSummary ?? subtitle

  const filePath = typeof toolCall.input?.file_path === 'string'
    ? (toolCall.input.file_path as string)
    : typeof toolCall.input?.path === 'string'
      ? (toolCall.input.path as string)
      : null

  const statusColor = isQueued
    ? tokens.colors.text.disabled
    : isRunning
      ? tokens.colors.toolCall.runningText
      : isError
        ? tokens.colors.accent.red
        : tokens.colors.accent.green

  const readSummary = useMemo(
    () => isReadTool && !isRunning ? buildReadSummary(toolCall.toolName, toolCall.result, toolCall.input) : null,
    [isReadTool, isRunning, toolCall.toolName, toolCall.result, toolCall.input],
  )

  const isSubAgentSpawner = SUBAGENT_SPAWNERS.has(toolCall.toolName)
  // In terminal mode, only code diffs are shown as results.
  // Screenshots are extracted below and always rendered.
  // Errors are shown for all tools (critical for debugging).
  // Success results for execute_command, MCP, etc. are intentionally hidden.
  const screenshotSrc = toolCall.result ? extractImageSrc(toolCall.result) : null
  const taskListResult =
    toolCall.toolName === 'update_tasks' &&
    !isRunning &&
    !isError
      ? buildTaskListPreview(toolCall.result)
      : null

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
        >
          {/* Refined-terminal: hard-step frame-swap spinner (replaces the eased
              CSS `toolSpin` rotation of the old '⟳'). Rendered via <Spinner>
              (not the useSpinnerFrame hook) so no hook sits after this
              component's isShellTool early-return — keeps rules-of-hooks clean. */}
          {isRunning ? <Spinner active /> : '●'}
        </Text>

        <Text
          fontSize="13px"
          fontWeight="600"
          color={tokens.colors.terminal.foreground}
          flexShrink={0}
        >
          {verb}
          {headerSubtitle && (
            <Text as="span" color={tokens.colors.text.muted} fontWeight="400">
              ({headerSubtitle.length > 70 ? shortenPath(headerSubtitle) : headerSubtitle})
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
            borderRadius={tokens.radius.sm}
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

        {/* Screenshots — always visible (browser_take_screenshot, etc.).
            Flat: no rounded corners; a 1px hairline is the only separation cue. */}
        {screenshotSrc && (
          <Box mt="3px" overflow="hidden" maxW="480px">
            <Image
              src={screenshotSrc}
              alt="Screenshot"
              w="100%"
              border="1px solid rgba(255,255,255,0.06)"
            />
          </Box>
        )}

        {/* Task updates: show unfinished/new tasks inline. Completed lists stay hidden.
            Flat: flows flush under the body's left gutter — no card border/fill/radius. */}
        {taskListResult && (
          <Box mt="3px" py="2px">
            <Text
              fontSize="12px"
              color={tokens.colors.text.secondary}
              whiteSpace="pre-wrap"
              lineHeight="1.5"
              fontFamily={tokens.fontFamily.mono}
            >
              {taskListResult}
            </Text>
          </Box>
        )}

        {/* Error result for any tool — always shown for debugging.
            Flat: the semantic red lives in the text/gutter, not a filled card. */}
        {isError && toolCall.result && !hasDiff && !isReadTool && !isSubAgentSpawner && (
          <Box mt="3px" py="2px">
            <Text
              fontSize="12px"
              color={tokens.colors.accent.red}
              whiteSpace="pre-wrap"
              lineHeight="1.5"
              fontFamily={tokens.fontFamily.mono}
            >
              {toolCall.result.length > RESULT_PREVIEW_CHARS
                ? toolCall.result.slice(0, RESULT_PREVIEW_CHARS)
                : toolCall.result}
            </Text>
            {toolCall.result.length > RESULT_PREVIEW_CHARS && (
              <Text
                mt="2px"
                fontSize="10px"
                color={tokens.colors.text.disabled}
                fontFamily={tokens.fontFamily.mono}
                fontStyle="italic"
              >
                … {toolCall.result.length - RESULT_PREVIEW_CHARS} more chars
              </Text>
            )}
          </Box>
        )}

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

        {/* Live progress — shown when commandLogs is not populated (single-line fallback).
            Hard-step frame-swap spinner replaces the eased `toolProgressPulse` dot. */}
        {(!toolCall.commandLogs || toolCall.commandLogs.length === 0) && toolCall.progressText && (
          <Flex align="center" gap={1.5} mt="3px" color={tokens.colors.toolCall.runningText}>
            <Text fontSize="11px" fontFamily={tokens.fontFamily.mono} lineHeight="1">
              <Spinner active />
            </Text>
            <Text fontSize="11px" color={tokens.colors.toolCall.runningText} fontFamily={tokens.fontFamily.mono}>
              {toolCall.progressText}
            </Text>
          </Flex>
        )}
      </Box>
    </Box>
  )
})
