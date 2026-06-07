import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiCheck, FiChevronDown, FiChevronRight, FiLoader, FiTerminal, FiX } from 'react-icons/fi'
import type { ToolCallDisplay } from '../../types/chat'
import { tokens } from '@/theme/tokens'

interface ShellCommandBlockProps {
  toolCall: ToolCallDisplay
  mode: 'chat' | 'terminal'
  nested?: boolean
}

interface ShellSessionBlockProps {
  toolCalls: ToolCallDisplay[]
  mode: 'chat' | 'terminal'
  nested?: boolean
}

const SHELL_TOOLS = new Set([
  'execute_command',
  'execute_command_background',
  'check_background_commands',
  'agent_shell_start',
  'agent_shell_write',
  'agent_shell_read',
  'agent_shell_stop',
])

const AGENT_SHELL_TOOLS = new Set([
  'agent_shell_start',
  'agent_shell_write',
  'agent_shell_read',
  'agent_shell_stop',
])

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName)
}

export function isAgentShellTool(toolName: string): boolean {
  return AGENT_SHELL_TOOLS.has(toolName)
}

export type AgentShellDisplayGroup =
  | { kind: 'agent_shell_session'; calls: ToolCallDisplay[] }
  | { kind: 'single'; call: ToolCallDisplay }

export function groupConsecutiveAgentShellCalls(calls: ToolCallDisplay[]): AgentShellDisplayGroup[] {
  const groups: AgentShellDisplayGroup[] = []

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]
    if (!isAgentShellTool(call.toolName)) {
      groups.push({ kind: 'single', call })
      continue
    }

    const sessionCalls = [call]
    while (i + 1 < calls.length && isAgentShellTool(calls[i + 1].toolName)) {
      sessionCalls.push(calls[i + 1])
      i++
    }
    groups.push({ kind: 'agent_shell_session', calls: sessionCalls })
  }

  return groups
}

function getDisplayCommand(toolCall: ToolCallDisplay): string {
  const command = typeof toolCall.input?.command === 'string' ? toolCall.input.command.trim() : ''
  if (command) return command

  if (toolCall.toolName === 'check_background_commands') {
    const id = typeof toolCall.input?.id === 'string' ? toolCall.input.id.trim() : ''
    return id ? `check_background_commands --id ${id}` : 'check_background_commands'
  }

  if (toolCall.toolName === 'agent_shell_start') {
    const cwd = typeof toolCall.input?.cwd === 'string' ? toolCall.input.cwd.trim() : ''
    return cwd ? `# start agent shell (${cwd})` : '# start agent shell'
  }

  if (toolCall.toolName === 'agent_shell_write') {
    const line = typeof toolCall.input?.input === 'string' ? toolCall.input.input.trim() : ''
    return line || '# write to agent shell'
  }

  if (toolCall.toolName === 'agent_shell_read') {
    return '# read agent shell output'
  }

  if (toolCall.toolName === 'agent_shell_stop') {
    return '# stop agent shell'
  }

  return toolCall.toolName
}

function getExitCode(result: string | undefined): number | null {
  if (!result) return null
  const match = result.match(/Exit code:\s*(-?\d+)/i)
  return match ? Number(match[1]) : null
}

function getResultWithoutExitCode(result: string | undefined): string {
  if (!result) return ''
  return result.replace(/\n?Exit code:\s*-?\d+\s*$/i, '').trimEnd()
}

function splitResultLines(result: string): string[] {
  if (!result) return []
  return result.split('\n')
}

function applyBackspaces(text: string): string {
  const chars: string[] = []
  for (const ch of text) {
    if (ch === '\b') chars.pop()
    else chars.push(ch)
  }
  return chars.join('')
}

function normalizeTerminalText(text: string): string {
  return applyBackspaces(text)
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
}

function compactForEchoCompare(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

function isLikelyCommandEchoFragment(fragment: string, commandCompact: string): boolean {
  if (!fragment) return true
  if (!commandCompact) return false
  if (fragment === commandCompact) return true
  if (commandCompact.startsWith(fragment)) return true
  if (commandCompact.includes(fragment) && fragment.length >= 2) return true
  if (fragment.length === 1 && /[^a-z0-9]/i.test(fragment) && commandCompact.includes(fragment)) return true
  if (fragment.includes(commandCompact)) return true
  return false
}

function stripCommandEcho(output: string, command: string): string {
  const normalizedOutput = normalizeTerminalText(output)
  const normalizedCommand = normalizeTerminalText(command).trim()
  if (!normalizedOutput || !normalizedCommand) return normalizedOutput

  const lines = normalizedOutput.split('\n')
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()

  const commandCompact = compactForEchoCompare(normalizedCommand)
  for (let count = 1; count <= Math.min(4, lines.length); count++) {
    const candidate = compactForEchoCompare(lines.slice(0, count).join(''))
    if (candidate === commandCompact) {
      return lines.slice(count).join('\n').replace(/^\n+/, '')
    }
  }

  if (lines[0]?.trim() === normalizedCommand) {
    return lines.slice(1).join('\n').replace(/^\n+/, '')
  }

  // PTYs sometimes echo a submitted line as progressive redraw fragments:
  // "s", "ssh -o StrictHostKeyC", "hecking=", ... These are not command
  // output; keep discarding leading fragments while each one is part of the
  // command text, then show the first real output line.
  let echoEnd = -1
  let consumed = ''
  const maxEchoLines = Math.min(lines.length, 80)
  for (let i = 0; i < maxEchoLines; i++) {
    const fragment = compactForEchoCompare(lines[i])
    if (!fragment) {
      if (echoEnd >= 0) echoEnd = i
      continue
    }

    const nextConsumed = consumed + fragment
    if (
      isLikelyCommandEchoFragment(fragment, commandCompact) ||
      commandCompact.startsWith(nextConsumed) ||
      nextConsumed === commandCompact
    ) {
      consumed = nextConsumed.length <= commandCompact.length ? nextConsumed : consumed
      echoEnd = i
      continue
    }
    break
  }

  if (echoEnd >= 0) {
    return lines.slice(echoEnd + 1).join('\n').replace(/^\n+/, '')
  }

  return lines.join('\n')
}

function extractAgentShellOutput(toolCall: ToolCallDisplay): string {
  const command = typeof toolCall.input?.input === 'string' ? toolCall.input.input.trim() : ''
  if (toolCall.commandLogs && toolCall.commandLogs.length > 0) {
    return stripCommandEcho(toolCall.commandLogs.join('\n'), command)
  }
  const result = toolCall.result || ''
  if (!result) return ''

  const outputMatch = result.match(/(?:initial_output|output):\n([\s\S]*?)(?:\nshell_(?:status|exit_code):|\nAgent shell stopped:|$)/)
  if (outputMatch) return stripCommandEcho(outputMatch[1], command).trimEnd()

  if (/output:\s*\(none yet\)|output:\s*\(no new output\)|initial_output:\s*\(none yet\)/i.test(result)) {
    return ''
  }

  return normalizeTerminalText(result)
    .replace(/^session_id:.*$/gm, '')
    .replace(/^sent:.*$/gm, '')
    .replace(/^shell_(?:status|exit_code):.*$/gm, '')
    .replace(/^Agent shell started\.$/gm, '')
    .trim()
}

function getLineColor(line: string, isError: boolean): string {
  if (isError) return tokens.colors.accent.red
  const lower = line.toLowerCase()
  if (/^(?:stderr:|error|fatal|fail(?:ed)?|\[error\])/i.test(line)) return tokens.colors.accent.red
  if (/error|exception|panic|fatal/i.test(lower) && !/0 error/i.test(line)) return tokens.colors.accent.red
  if (/^(?:warn(?:ing)?|\[warn\])/i.test(line)) return tokens.colors.accent.orange
  if (/^(?:success|done|ok(?:ay)?|\[ok\])/i.test(line) || /\bpassed\b|\bsuccess\b/i.test(lower)) {
    return tokens.colors.accent.green
  }
  return tokens.colors.terminal.foreground
}

function StatusIcon({ status }: { status: ToolCallDisplay['status'] }) {
  if (status === 'running') {
    return (
      <Box
        color={tokens.colors.toolCall.runningText}
        flexShrink={0}
        css={{
          animation: 'shellSpin 1s linear infinite',
          '@keyframes shellSpin': {
            from: { transform: 'rotate(0deg)' },
            to: { transform: 'rotate(360deg)' },
          },
        }}
      >
        <FiLoader size={12} />
      </Box>
    )
  }
  if (status === 'failed') {
    return (
      <Box color={tokens.colors.accent.red} flexShrink={0}>
        <FiX size={12} />
      </Box>
    )
  }
  return (
    <Box color={tokens.colors.accent.green} flexShrink={0}>
      <FiCheck size={12} />
    </Box>
  )
}

export const ShellCommandBlock = memo(function ShellCommandBlock({
  toolCall,
  mode,
  nested = false,
}: ShellCommandBlockProps) {
  const [expanded, setExpanded] = useState(mode === 'terminal')
  const command = getDisplayCommand(toolCall)
  const cwd = typeof toolCall.input?.cwd === 'string' ? toolCall.input.cwd : ''
  const isRunning = toolCall.status === 'running'
  const isError = toolCall.isError || toolCall.status === 'failed'
  const exitCode = getExitCode(toolCall.result)
  const resultText = getResultWithoutExitCode(toolCall.result)
  const resultLines = useMemo(() => splitResultLines(resultText), [resultText])
  const logLines = toolCall.commandLogs || []
  const visibleResultLines = expanded ? resultLines : resultLines.slice(0, 8)
  const visibleLogLines = expanded ? logLines : logLines.slice(-8)
  const hasMore = resultLines.length > visibleResultLines.length || logLines.length > visibleLogLines.length
  const hasBody = isRunning || logLines.length > 0 || resultLines.length > 0 || !!toolCall.progressText
  const promptSymbol = mode === 'terminal' ? '%' : '$'

  const borderColor = isRunning
    ? 'rgba(240, 192, 0, 0.16)'
    : isError
      ? 'rgba(248, 81, 73, 0.2)'
      : 'rgba(255, 255, 255, 0.08)'

  return (
    <Box
      my={mode === 'terminal' ? 1.5 : 2}
      borderRadius={mode === 'terminal' ? '5px' : '8px'}
      overflow="hidden"
      border={`1px solid ${borderColor}`}
      bg={mode === 'terminal' ? 'rgba(0, 0, 0, 0.2)' : 'rgba(13, 17, 23, 0.68)'}
      fontFamily={tokens.fontFamily.mono}
      {...(nested
        ? {
            ml: 4,
            pl: 2,
            borderLeft: `2px solid ${tokens.colors.accent.purple}`,
          }
        : {})}
    >
      <Flex
        align="center"
        gap={2}
        px={mode === 'terminal' ? 2 : 3}
        py={mode === 'terminal' ? '6px' : '8px'}
        bg={mode === 'terminal' ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.035)'}
        borderBottom={hasBody ? '1px solid rgba(255,255,255,0.06)' : undefined}
        cursor={hasBody ? 'pointer' : 'default'}
        onClick={() => {
          if (hasBody) setExpanded(v => !v)
        }}
      >
        <StatusIcon status={toolCall.status} />
        <Box color={tokens.colors.text.muted} flexShrink={0}>
          <FiTerminal size={13} />
        </Box>
        <Text
          fontSize="11px"
          color={tokens.colors.text.secondary}
          fontWeight="600"
          flexShrink={0}
        >
          shell
        </Text>
        {cwd && (
          <Text
            fontSize="10px"
            color={tokens.colors.text.disabled}
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            minW={0}
          >
            {cwd}
          </Text>
        )}
        <Box flex="1" />
        {exitCode !== null && (
          <Text
            fontSize="10px"
            color={exitCode === 0 ? tokens.colors.accent.green : tokens.colors.accent.red}
            border={`1px solid ${exitCode === 0 ? 'rgba(46,160,67,0.28)' : 'rgba(248,81,73,0.28)'}`}
            borderRadius="4px"
            px="6px"
            py="1px"
            flexShrink={0}
          >
            exit {exitCode}
          </Text>
        )}
        {hasBody && (
          <Box color={tokens.colors.text.disabled} flexShrink={0}>
            {expanded ? <FiChevronDown size={13} /> : <FiChevronRight size={13} />}
          </Box>
        )}
      </Flex>

      <Box px={mode === 'terminal' ? 2 : 3} py={mode === 'terminal' ? '6px' : '9px'}>
        <Flex align="flex-start" gap={2} minW={0}>
          <Text color={tokens.colors.accent.primary} flexShrink={0} fontSize="12px" lineHeight="20px">
            {promptSymbol}
          </Text>
          <Text
            color={tokens.colors.terminal.foreground}
            fontSize="12px"
            lineHeight="20px"
            whiteSpace="pre-wrap"
            overflowWrap="anywhere"
            userSelect="text"
            data-selectable="true"
          >
            {command}
          </Text>
        </Flex>

        {hasBody && expanded && (
          <Box
            mt="6px"
            maxH={mode === 'terminal' ? '360px' : '280px'}
            overflowY="auto"
            overflowX="hidden"
            css={{
              '&::-webkit-scrollbar': { width: '4px', height: '4px' },
              '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.12)', borderRadius: '2px' },
              '&::-webkit-scrollbar-track': { background: 'transparent' },
            }}
          >
            {visibleLogLines.map((line, i) => (
              <Text
                key={`log-${i}-${line.slice(0, 18)}`}
                fontSize="12px"
                lineHeight="19px"
                color={getLineColor(line, false)}
                whiteSpace="pre-wrap"
                overflowWrap="anywhere"
                userSelect="text"
                data-selectable="true"
              >
                {line}
              </Text>
            ))}

            {toolCall.progressText && isRunning && logLines.length === 0 && (
              <Text
                fontSize="12px"
                lineHeight="19px"
                color={tokens.colors.toolCall.runningText}
                whiteSpace="pre-wrap"
                overflowWrap="anywhere"
              >
                {toolCall.progressText}
              </Text>
            )}

            {visibleResultLines.map((line, i) => (
              <Text
                key={`result-${i}-${line.slice(0, 18)}`}
                fontSize="12px"
                lineHeight="19px"
                color={getLineColor(line, isError)}
                whiteSpace="pre-wrap"
                overflowWrap="anywhere"
                userSelect="text"
                data-selectable="true"
              >
                {line}
              </Text>
            ))}

            {isRunning && (
              <Text
                as="span"
                display="inline-block"
                w="8px"
                h="16px"
                mt="2px"
                bg={tokens.colors.text.muted}
                opacity={0.8}
                css={{
                  animation: 'shellCursor 1s steps(2, start) infinite',
                  '@keyframes shellCursor': {
                    '0%': { opacity: 0.8 },
                    '50%': { opacity: 0 },
                  },
                }}
              />
            )}

            {hasMore && (
              <Text
                mt="5px"
                fontSize="10px"
                color={tokens.colors.text.disabled}
                cursor="pointer"
                onClick={(event) => {
                  event.stopPropagation()
                  setExpanded(true)
                }}
              >
                {resultLines.length + logLines.length - visibleResultLines.length - visibleLogLines.length} more lines
              </Text>
            )}
          </Box>
        )}
      </Box>
    </Box>
  )
})

export const ShellSessionBlock = memo(function ShellSessionBlock({
  toolCalls,
  mode,
  nested = false,
}: ShellSessionBlockProps) {
  const [expanded, setExpanded] = useState(true)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const isRunning = toolCalls.some(tc => tc.status === 'running')
  const last = toolCalls[toolCalls.length - 1]
  const isCurrentError = !isRunning && !!last && (last.isError || last.status === 'failed')
  const cwd = typeof toolCalls[0]?.input?.cwd === 'string' ? toolCalls[0].input.cwd : ''
  const promptSymbol = mode === 'terminal' ? '%' : '$'
  const shellOutputKey = toolCalls
    .map(tc => `${tc.id}:${tc.status}:${tc.commandLogs?.length ?? 0}:${tc.result?.length ?? 0}`)
    .join('|')
  const transcript = useMemo(() => {
    const entries: Array<{
      id: string
      type: 'command' | 'output'
      text: string
      isError?: boolean
    }> = []

    for (const toolCall of toolCalls) {
      const output = extractAgentShellOutput(toolCall)
      const outputLines = splitResultLines(output).filter((line, index, lines) => {
        if (line.trim() !== '') return true
        return index > 0 && index < lines.length - 1
      })
      const isCallError = toolCall.isError || toolCall.status === 'failed'

      if (toolCall.toolName === 'agent_shell_write') {
        entries.push({
          id: `${toolCall.id}-cmd`,
          type: 'command',
          text: getDisplayCommand(toolCall),
          isError: isCallError,
        })
      }

      for (let i = 0; i < outputLines.length; i++) {
        entries.push({
          id: `${toolCall.id}-out-${i}`,
          type: 'output',
          text: outputLines[i],
          isError: isCallError,
        })
      }
    }

    return entries
  }, [toolCalls, shellOutputKey])
  const visibleTranscript = expanded ? transcript : transcript.slice(-12)
  const hasMore = transcript.length > visibleTranscript.length

  useEffect(() => {
    if (!expanded || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [expanded, shellOutputKey, transcript.length])

  const borderColor = isRunning
    ? 'rgba(240, 192, 0, 0.16)'
    : isCurrentError
      ? 'rgba(248, 81, 73, 0.2)'
      : 'rgba(255, 255, 255, 0.08)'

  return (
    <Box
      my={mode === 'terminal' ? 1.5 : 2}
      borderRadius={mode === 'terminal' ? '5px' : '8px'}
      overflow="hidden"
      border={`1px solid ${borderColor}`}
      bg={mode === 'terminal' ? 'rgba(0, 0, 0, 0.2)' : 'rgba(13, 17, 23, 0.68)'}
      fontFamily={tokens.fontFamily.mono}
      {...(nested
        ? {
            ml: 4,
            pl: 2,
            borderLeft: `2px solid ${tokens.colors.accent.purple}`,
          }
        : {})}
    >
      <Flex
        align="center"
        gap={2}
        px={mode === 'terminal' ? 2 : 3}
        py={mode === 'terminal' ? '6px' : '8px'}
        bg={mode === 'terminal' ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.035)'}
        borderBottom="1px solid rgba(255,255,255,0.06)"
        cursor="pointer"
        onClick={() => setExpanded(v => !v)}
      >
        <StatusIcon status={isCurrentError ? 'failed' : isRunning ? 'running' : 'completed'} />
        <Box color={tokens.colors.text.muted} flexShrink={0}>
          <FiTerminal size={13} />
        </Box>
        <Text fontSize="11px" color={tokens.colors.text.secondary} fontWeight="600" flexShrink={0}>
          agent shell
        </Text>
        {cwd && (
          <Text
            fontSize="10px"
            color={tokens.colors.text.disabled}
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            minW={0}
          >
            {cwd}
          </Text>
        )}
        <Box flex="1" />
        <Text fontSize="10px" color={tokens.colors.text.disabled} flexShrink={0}>
          {toolCalls.length} step{toolCalls.length === 1 ? '' : 's'}
        </Text>
        {last?.toolName === 'agent_shell_stop' && (
          <Text
            fontSize="10px"
            color={tokens.colors.accent.green}
            border="1px solid rgba(46,160,67,0.28)"
            borderRadius="4px"
            px="6px"
            py="1px"
            flexShrink={0}
          >
            closed
          </Text>
        )}
        <Box color={tokens.colors.text.disabled} flexShrink={0}>
          {expanded ? <FiChevronDown size={13} /> : <FiChevronRight size={13} />}
        </Box>
      </Flex>

      <Box
        ref={scrollRef}
        px={mode === 'terminal' ? 2 : 3}
        py={mode === 'terminal' ? '8px' : '10px'}
        maxH={mode === 'terminal' ? '520px' : '420px'}
        overflowY="auto"
        overflowX="hidden"
        css={{
          '&::-webkit-scrollbar': { width: '4px', height: '4px' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.12)', borderRadius: '2px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
        }}
      >
        {hasMore && (
          <Text mb="5px" fontSize="10px" color={tokens.colors.text.disabled}>
            {transcript.length - visibleTranscript.length} earlier lines hidden
          </Text>
        )}

        {visibleTranscript.map((entry) => (
          entry.type === 'command' ? (
            <Flex key={entry.id} align="flex-start" gap={2} minW={0} mb="2px">
              <Text
                color={tokens.colors.accent.primary}
                flexShrink={0}
                fontSize="12px"
                lineHeight="20px"
              >
                {promptSymbol}
              </Text>
              <Text
                color={entry.isError ? tokens.colors.accent.red : tokens.colors.terminal.foreground}
                fontSize="12px"
                lineHeight="20px"
                whiteSpace="pre-wrap"
                overflowWrap="break-word"
                wordBreak="normal"
                userSelect="text"
                data-selectable="true"
              >
                {entry.text}
              </Text>
            </Flex>
          ) : (
            <Text
              key={entry.id}
              pl="22px"
              fontSize="12px"
              lineHeight="19px"
              color={getLineColor(entry.text, !!entry.isError)}
              whiteSpace="pre-wrap"
              overflowWrap="break-word"
              wordBreak="normal"
              userSelect="text"
              data-selectable="true"
            >
              {entry.text || ' '}
            </Text>
          )
        ))}

        {transcript.length === 0 && !isRunning && (
          <Text fontSize="12px" lineHeight="19px" color={tokens.colors.text.disabled}>
            shell session opened
          </Text>
        )}

        {isRunning && (
          <>
            {last?.toolName !== 'agent_shell_write' && (
              <Flex align="flex-start" gap={2} minW={0}>
                <Text
                  color={tokens.colors.accent.primary}
                  flexShrink={0}
                  fontSize="12px"
                  lineHeight="20px"
                >
                  {promptSymbol}
                </Text>
                <Text
                  color={tokens.colors.text.disabled}
                  fontSize="12px"
                  lineHeight="20px"
                  whiteSpace="pre-wrap"
                  overflowWrap="break-word"
                >
                  waiting for output
                </Text>
              </Flex>
            )}
            <Text
              as="span"
              display="inline-block"
              w="8px"
              h="16px"
              ml="22px"
              mt="2px"
              bg={tokens.colors.text.muted}
              opacity={0.8}
              css={{
                animation: 'shellCursor 1s steps(2, start) infinite',
                '@keyframes shellCursor': {
                  '0%': { opacity: 0.8 },
                  '50%': { opacity: 0 },
                },
              }}
            />
          </>
        )}
      </Box>
    </Box>
  )
})
