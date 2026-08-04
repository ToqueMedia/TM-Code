import { memo, useEffect, useMemo, useRef, useState, type DependencyList } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiCheck, FiChevronDown, FiChevronRight, FiLoader, FiTerminal, FiX } from 'react-icons/fi'
import type { ToolCallDisplay } from '../../types/chat'
import { tokens } from '@/theme/tokens'
import { normalizeTerminalText } from '@/utils/stripAnsi'
import { shallowArrayEqual } from '@/utils/shallowArrayEqual'

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

/**
 * Resolve the persistent PTY session id for an agent_shell_* tool call.
 * start may only expose the id in `result` until later writes carry it in input.
 */
export function resolveAgentShellSessionId(toolCall: ToolCallDisplay): string | null {
  const fromInput = toolCall.input?.session_id
  if (typeof fromInput === 'string' && fromInput.trim()) return fromInput.trim()

  const result = toolCall.result || ''
  const match = result.match(/session_id:\s*(\S+)/i)
  if (match?.[1]) return match[1]

  // start before result lands — use toolCall id as a stable provisional key
  if (toolCall.toolName === 'agent_shell_start') return `pending:${toolCall.id}`
  return null
}

export type AgentShellDisplayGroup =
  | { kind: 'agent_shell_session'; calls: ToolCallDisplay[]; sessionId: string }
  | { kind: 'single'; call: ToolCallDisplay }

/**
 * Group agent_shell_* tools by session_id (not mere adjacency).
 * Reasoning/text between write/read used to split one PTY into dozens of
 * "agent shell · 1 step" cards during long deploys (session 2026-07-24).
 * Non-shell tools keep their place as `single` in first-seen order.
 */
export function groupAgentShellBySession(calls: ToolCallDisplay[]): AgentShellDisplayGroup[] {
  const sessionOrder: string[] = []
  const bySession = new Map<string, ToolCallDisplay[]>()
  for (const call of calls) {
    if (!isAgentShellTool(call.toolName)) continue
    const sid = resolveAgentShellSessionId(call) || `orphan:${call.id}`
    if (!bySession.has(sid)) {
      bySession.set(sid, [])
      sessionOrder.push(sid)
    }
    bySession.get(sid)!.push(call)
  }

  // Promote provisional start keys once a real session_id appears in a later call.
  // (start: pending:X, write: agent-shell-… — merge if start is first and only provisional)
  // Keep simple: already keyed by best-available id per call at walk time.

  const groups: AgentShellDisplayGroup[] = []
  const emittedSessions = new Set<string>()

  for (const call of calls) {
    if (!isAgentShellTool(call.toolName)) {
      groups.push({ kind: 'single', call })
      continue
    }
    const sid = resolveAgentShellSessionId(call) || `orphan:${call.id}`
    if (emittedSessions.has(sid)) continue
    emittedSessions.add(sid)
    groups.push({
      kind: 'agent_shell_session',
      sessionId: sid,
      calls: bySession.get(sid) || [call],
    })
  }

  return groups
}

/** @deprecated use groupAgentShellBySession — kept for callers that only need consecutive. */
export function groupConsecutiveAgentShellCalls(calls: ToolCallDisplay[]): AgentShellDisplayGroup[] {
  return groupAgentShellBySession(calls)
}

function getDisplayCommand(toolCall: ToolCallDisplay): string {
  const command = typeof toolCall.input?.command === 'string' ? toolCall.input.command.trim() : ''
  if (command) return command

  if (toolCall.toolName === 'check_background_commands') {
    const id = typeof toolCall.input?.id === 'string' ? toolCall.input.id.trim() : ''
    return id ? `# check background command ${id}` : '# check background commands'
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

// ─── Revelação progressiva + auto abrir/fechar (UX 2026-06-12) ──────────────
//
// O resultado de um comando chega de uma vez (toolCall.result) quando ele
// termina — despejado instantaneamente, o user não "vê acontecer". Este hook
// revela as linhas em passos curtos (efeito streaming, capped a ~2.5s no
// total para outputs longos), o scroll interno acompanha, e no fim o bloco
// FECHA sozinho (o header fica clicável para reabrir). Histórico carregado
// do disco nunca anima nem abre — só pedidos cuja execução foi testemunhada
// neste mount.

const REVEAL_TICK_MS = 48
const REVEAL_MAX_DURATION_MS = 3200
const AUTO_COLLAPSE_DELAY_MS = 1600
const PINNED_SCROLL_THRESHOLD = 48

function useProgressiveReveal(total: number, animate: boolean): number {
  const [visible, setVisible] = useState(() => (animate ? 0 : total))
  const targetRef = useRef(total)
  targetRef.current = total

  useEffect(() => {
    if (!animate) {
      setVisible(total)
      return
    }
    if (total <= 0) return
    // Passo dimensionado para o reveal completo nunca exceder o cap — 2
    // linhas/tick no mínimo para outputs curtos ainda parecerem vivos.
    const perTick = Math.max(2, Math.ceil(total / (REVEAL_MAX_DURATION_MS / REVEAL_TICK_MS)))
    const id = window.setInterval(() => {
      setVisible(v => {
        if (v >= targetRef.current) {
          window.clearInterval(id)
          return v
        }
        return Math.min(targetRef.current, v + perTick)
      })
    }, REVEAL_TICK_MS)
    return () => window.clearInterval(id)
  }, [total, animate])

  return Math.min(visible, total)
}

function usePinnedScroll(deps: DependencyList, enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)

  useEffect(() => {
    if (!enabled) return
    const node = ref.current
    if (!node || !pinnedRef.current) return
    const frame = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return {
    ref,
    onScroll: () => {
      const node = ref.current
      if (!node) return
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
      pinnedRef.current = distanceFromBottom < PINNED_SCROLL_THRESHOLD
    },
  }
}

/**
 * Estado expandido com gestão automática: aberto enquanto corre/revela,
 * fecha sozinho `AUTO_COLLAPSE_DELAY_MS` depois de terminar. O clique do
 * user no header sobrepõe-se ao automatismo a partir desse momento.
 * `witnessed` = a execução começou neste mount (histórico fica fechado).
 */
function useAutoExpand(isRunning: boolean, revealing: boolean, keepOpen = false): {
  expanded: boolean
  witnessed: boolean
  toggle: () => void
} {
  const witnessedRef = useRef(isRunning)
  if (isRunning) witnessedRef.current = true
  const witnessed = witnessedRef.current

  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const [autoCollapsed, setAutoCollapsed] = useState(false)

  useEffect(() => {
    if (!witnessed) return
    if (isRunning || revealing || keepOpen) {
      setAutoCollapsed(false)
      return
    }
    const id = setTimeout(() => setAutoCollapsed(true), AUTO_COLLAPSE_DELAY_MS)
    return () => clearTimeout(id)
  }, [witnessed, isRunning, revealing, keepOpen])

  const autoExpanded = witnessed && !autoCollapsed
  const expanded = userToggled ?? autoExpanded

  return {
    expanded,
    witnessed,
    toggle: () => setUserToggled(prev => !(prev ?? expanded)),
  }
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

function NativeWindowDots() {
  return (
    <Flex align="center" gap="4px" flexShrink={0} aria-hidden="true">
      <Box w="7px" h="7px" borderRadius="full" bg="rgba(255, 95, 87, 0.8)" />
      <Box w="7px" h="7px" borderRadius="full" bg="rgba(255, 189, 46, 0.78)" />
      <Box w="7px" h="7px" borderRadius="full" bg="rgba(40, 202, 66, 0.72)" />
    </Flex>
  )
}

export const ShellCommandBlock = memo(function ShellCommandBlock({
  toolCall,
  mode,
  nested = false,
}: ShellCommandBlockProps) {
  const command = getDisplayCommand(toolCall)
  const cwd = typeof toolCall.input?.cwd === 'string' ? toolCall.input.cwd : ''
  const isRunning = toolCall.status === 'running'
  const isError = toolCall.isError || toolCall.status === 'failed'
  const exitCode = getExitCode(toolCall.result)
  // ALWAYS strip ANSI before paint — execute_command results and live
  // commandLogs carry SGR color codes; without strip the chat shows noise
  // like `[38;5;246m` (xterm would interpret them; plain Text does not).
  const resultText = normalizeTerminalText(getResultWithoutExitCode(toolCall.result))
  const resultLines = useMemo(() => splitResultLines(resultText), [resultText])
  const logLines = useMemo(
    () => (toolCall.commandLogs || []).map(line => normalizeTerminalText(line)),
    [toolCall.commandLogs],
  )

  // Revelação progressiva do resultado (só quando vimos o comando a correr
  // neste mount) + bloco auto-gerido: aberto durante a execução, fecha
  // sozinho no fim; clique reabre.
  const witnessedRunRef = useRef(isRunning)
  if (isRunning) witnessedRunRef.current = true
  const animateReveal = witnessedRunRef.current
  const revealCount = useProgressiveReveal(resultLines.length, animateReveal)
  const revealing = animateReveal && revealCount < resultLines.length
  // Contrato 2026-07-17 (pedido do user): comandos one-shot ABREM e FICAM
  // abertos — o output sobe tipo créditos de filme numa janela BAIXA (maxH
  // compacto + pinned scroll, mesma velocidade de reveal) e o user pode
  // scrollar quando quiser. Só o histórico re-montado continua fechado
  // (witnessed=false). O auto-fecho ficou EXCLUSIVO das sessões longas de
  // terminal (ShellSessionBlock: ssh/agent shell).
  const { expanded, toggle } = useAutoExpand(isRunning, revealing, true)

  const visibleResultLines = animateReveal ? resultLines.slice(0, revealCount) : resultLines
  const visibleLogLines = logLines
  const hasBody = isRunning || logLines.length > 0 || resultLines.length > 0 || !!toolCall.progressText
  const promptSymbol = mode === 'terminal' ? '%' : '$'

  // Scroll follows the live output only while the user is still pinned near
  // the bottom. Manual upward scroll pauses the automatic pull.
  const outputScroll = usePinnedScroll(
    [expanded, isRunning, revealing, revealCount, logLines.length],
    expanded && (isRunning || revealing),
  )

  const borderColor = isRunning
    ? 'rgba(240, 192, 0, 0.16)'
    : isError
      ? 'rgba(248, 81, 73, 0.2)'
      : 'rgba(255, 255, 255, 0.08)'

  return (
    <Box
      my={mode === 'terminal' ? 1.5 : 2}
      borderRadius={mode === 'terminal' ? '10px' : '12px'}
      overflow="hidden"
      border={`1px solid ${borderColor}`}
      bg={mode === 'terminal' ? 'rgba(0, 0, 0, 0.28)' : 'rgba(10, 10, 10, 0.92)'}
      fontFamily={tokens.fontFamily.mono}
      boxShadow={mode === 'terminal' ? 'none' : '0 16px 38px rgba(0,0,0,0.26)'}
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
        px={mode === 'terminal' ? 2.5 : 3}
        py={mode === 'terminal' ? '7px' : '9px'}
        bg={mode === 'terminal'
          ? 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.018))'
          : 'linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.022))'}
        borderBottom={hasBody ? '1px solid rgba(255,255,255,0.075)' : undefined}
        cursor={hasBody ? 'pointer' : 'default'}
        _hover={hasBody ? { bg: 'rgba(255,255,255,0.045)' } : undefined}
        onClick={() => {
          if (hasBody) toggle()
        }}
      >
        <NativeWindowDots />
        <StatusIcon status={toolCall.status} />
        <Flex
          w="22px"
          h="22px"
          align="center"
          justify="center"
          borderRadius="6px"
          color={tokens.colors.text.muted}
          bg="rgba(255,255,255,0.045)"
          border="1px solid rgba(255,255,255,0.065)"
          flexShrink={0}
        >
          <FiTerminal size={13} />
        </Flex>
        <Text
          fontSize="11px"
          color={tokens.colors.text.secondary}
          fontWeight="700"
          flexShrink={0}
        >
          shell
        </Text>
        {cwd && (
          <Text
            fontSize="10px"
            color={tokens.colors.text.disabled}
            bg="rgba(255,255,255,0.035)"
            border="1px solid rgba(255,255,255,0.055)"
            borderRadius="999px"
            px="7px"
            py="2px"
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
            bg={exitCode === 0 ? 'rgba(46,160,67,0.1)' : 'rgba(248,81,73,0.1)'}
            borderRadius="999px"
            px="7px"
            py="2px"
            flexShrink={0}
            fontWeight="700"
            lineHeight="1"
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

      <Box px={mode === 'terminal' ? 2.5 : 3} py={mode === 'terminal' ? '8px' : '10px'} bg="rgba(0,0,0,0.14)">
        <Flex
          align="flex-start"
          gap={2}
          minW={0}
          px={2}
          py="6px"
          borderRadius="8px"
          bg="rgba(255,255,255,0.026)"
          border="1px solid rgba(255,255,255,0.05)"
        >
          <Text color={tokens.colors.accent.primary} flexShrink={0} fontSize="12px" lineHeight="20px" fontWeight="700">
            {promptSymbol}
          </Text>
          <Text
            color={tokens.colors.terminal.foreground}
            fontSize="12px"
            lineHeight="20px"
            whiteSpace="pre-wrap"
            overflowWrap="break-word"
            wordBreak="normal"
            userSelect="text"
            data-selectable="true"
          >
            {command}
          </Text>
        </Flex>

        {hasBody && expanded && (
          <Box
            ref={outputScroll.ref}
            onScroll={outputScroll.onScroll}
            mt="8px"
            // Janela de "créditos": ~7 linhas — presença viva sem engolir o
            // transcript; o conteúdo desliza por dentro (pinned scroll).
            maxH={mode === 'terminal' ? '188px' : '156px'}
            overflowY="auto"
            overflowX="hidden"
            px={2}
            py="7px"
            borderRadius="8px"
            bg="rgba(0,0,0,0.24)"
            border="1px solid rgba(255,255,255,0.045)"
            css={{
              '&::-webkit-scrollbar': { width: '4px', height: '4px' },
              '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.14)', borderRadius: '2px' },
              '&::-webkit-scrollbar-track': { background: 'transparent' },
            }}
          >
            {visibleLogLines.map((line, i) => (
              <Text
                key={`log-${i}-${line.slice(0, 18)}`}
                fontSize="12px"
                lineHeight="20px"
                color={getLineColor(line, false)}
                whiteSpace="pre-wrap"
                overflowWrap="break-word"
                wordBreak="normal"
                userSelect="text"
                data-selectable="true"
              >
                {line}
              </Text>
            ))}

            {toolCall.progressText && isRunning && logLines.length === 0 && (
              <Text
                fontSize="12px"
                lineHeight="20px"
                color={tokens.colors.toolCall.runningText}
                whiteSpace="pre-wrap"
                overflowWrap="break-word"
                wordBreak="normal"
              >
                {toolCall.progressText}
              </Text>
            )}

            {visibleResultLines.map((line, i) => (
              <Text
                key={`result-${i}-${line.slice(0, 18)}`}
                fontSize="12px"
                lineHeight="20px"
                color={getLineColor(line, isError)}
                whiteSpace="pre-wrap"
                overflowWrap="break-word"
                wordBreak="normal"
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

  // Revelação progressiva + auto abrir/fechar — mesmo contrato do
  // ShellCommandBlock: sessões testemunhadas neste mount abrem e revelam o
  // transcript a ritmo legível; ao terminar, o bloco fecha e o header fica
  // como recibo clicável. Histórico monta fechado e sem animação.
  const witnessedRunRef = useRef(isRunning)
  if (isRunning) witnessedRunRef.current = true
  const animateReveal = witnessedRunRef.current
  const revealCount = useProgressiveReveal(transcript.length, animateReveal)
  const revealing = animateReveal && revealCount < transcript.length
  const { expanded, toggle } = useAutoExpand(isRunning, revealing, isCurrentError)
  const visibleTranscript = animateReveal ? transcript.slice(0, revealCount) : transcript

  const sessionScroll = usePinnedScroll(
    [expanded, shellOutputKey, transcript.length, revealCount],
    expanded && (isRunning || revealing),
  )

  const borderColor = isRunning
    ? 'rgba(240, 192, 0, 0.16)'
    : isCurrentError
      ? 'rgba(248, 81, 73, 0.2)'
      : 'rgba(255, 255, 255, 0.08)'

  return (
    <Box
      my={mode === 'terminal' ? 1.5 : 2}
      borderRadius={mode === 'terminal' ? '10px' : '12px'}
      overflow="hidden"
      border={`1px solid ${borderColor}`}
      bg={mode === 'terminal' ? 'rgba(0, 0, 0, 0.28)' : 'rgba(10, 10, 10, 0.92)'}
      fontFamily={tokens.fontFamily.mono}
      boxShadow={mode === 'terminal' ? 'none' : '0 16px 38px rgba(0,0,0,0.26)'}
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
        px={mode === 'terminal' ? 2.5 : 3}
        py={mode === 'terminal' ? '7px' : '9px'}
        bg={mode === 'terminal'
          ? 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.018))'
          : 'linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.022))'}
        borderBottom={expanded ? '1px solid rgba(255,255,255,0.075)' : undefined}
        cursor="pointer"
        _hover={{ bg: 'rgba(255,255,255,0.045)' }}
        onClick={toggle}
      >
        <NativeWindowDots />
        <StatusIcon status={isCurrentError ? 'failed' : isRunning ? 'running' : 'completed'} />
        <Flex
          w="22px"
          h="22px"
          align="center"
          justify="center"
          borderRadius="6px"
          color={tokens.colors.text.muted}
          bg="rgba(255,255,255,0.045)"
          border="1px solid rgba(255,255,255,0.065)"
          flexShrink={0}
        >
          <FiTerminal size={13} />
        </Flex>
        <Text fontSize="11px" color={tokens.colors.text.secondary} fontWeight="700" flexShrink={0}>
          agent shell
        </Text>
        {cwd && (
          <Text
            fontSize="10px"
            color={tokens.colors.text.disabled}
            bg="rgba(255,255,255,0.035)"
            border="1px solid rgba(255,255,255,0.055)"
            borderRadius="999px"
            px="7px"
            py="2px"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            minW={0}
          >
            {cwd}
          </Text>
        )}
        <Box flex="1" />
        <Text
          fontSize="10px"
          color={tokens.colors.text.disabled}
          bg="rgba(255,255,255,0.035)"
          border="1px solid rgba(255,255,255,0.055)"
          borderRadius="999px"
          px="7px"
          py="2px"
          flexShrink={0}
          lineHeight="1"
          fontWeight="700"
        >
          {(() => {
            const commands = toolCalls.filter(tc => tc.toolName === 'agent_shell_write').length
            if (isRunning) return 'live'
            if (commands > 0) return `${commands} command${commands === 1 ? '' : 's'}`
            return `${toolCalls.length} step${toolCalls.length === 1 ? '' : 's'}`
          })()}
        </Text>
        {last?.toolName === 'agent_shell_stop' && (
          <Text
            fontSize="10px"
            color={tokens.colors.accent.green}
            border="1px solid rgba(46,160,67,0.28)"
            bg="rgba(46,160,67,0.1)"
            borderRadius="999px"
            px="7px"
            py="2px"
            flexShrink={0}
            lineHeight="1"
            fontWeight="700"
          >
            closed
          </Text>
        )}
        <Box color={tokens.colors.text.disabled} flexShrink={0}>
          {expanded ? <FiChevronDown size={13} /> : <FiChevronRight size={13} />}
        </Box>
      </Flex>

      {expanded && (
      <Box
        ref={sessionScroll.ref}
        onScroll={sessionScroll.onScroll}
        px={mode === 'terminal' ? 2.5 : 3}
        py={mode === 'terminal' ? '9px' : '11px'}
        maxH={mode === 'terminal' ? '560px' : '460px'}
        overflowY="auto"
        overflowX="hidden"
        bg="rgba(0,0,0,0.14)"
        css={{
          '&::-webkit-scrollbar': { width: '4px', height: '4px' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.14)', borderRadius: '2px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
        }}
      >
        {visibleTranscript.map((entry) => (
          entry.type === 'command' ? (
            <Flex
              key={entry.id}
              align="flex-start"
              gap={2}
              minW={0}
              mt={entry.id.endsWith('-cmd') ? 1 : 0}
              mb="3px"
              px={2}
              py="5px"
              borderRadius="8px"
              bg="rgba(255,255,255,0.026)"
              border="1px solid rgba(255,255,255,0.05)"
            >
              <Text
                color={tokens.colors.accent.primary}
                flexShrink={0}
                fontSize="12px"
                lineHeight="20px"
                fontWeight="700"
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
              pl="30px"
              pr={2}
              fontSize="12px"
              lineHeight="20px"
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
          <Text fontSize="12px" lineHeight="20px" color={tokens.colors.text.disabled}>
            shell session opened
          </Text>
        )}

        {isRunning && (
          <>
            {last?.toolName !== 'agent_shell_write' && (
              <Flex align="flex-start" gap={2} minW={0} px={2} py="5px" borderRadius="8px" bg="rgba(255,255,255,0.026)" border="1px solid rgba(255,255,255,0.05)">
                <Text
                  color={tokens.colors.accent.primary}
                  flexShrink={0}
                  fontSize="12px"
                  lineHeight="20px"
                  fontWeight="700"
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
      )}
    </Box>
  )
}, (prev, next) =>
  // Comparador por IDENTIDADE dos elementos (task #14): o MessageBubble
  // reconstrói o array toolCalls do bloco a cada flush de streaming
  // (filter por sessão), mas os elementos preservam identidade — o memo
  // shallow default nunca segurava e o terminal re-renderizava inteiro
  // ~10×/s durante o streaming.
  prev.mode === next.mode &&
  prev.nested === next.nested &&
  shallowArrayEqual(prev.toolCalls, next.toolCalls))
