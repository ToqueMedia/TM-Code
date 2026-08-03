import { memo, useState, useMemo } from 'react'
import { Box, Flex, Text, Image } from '@chakra-ui/react'
import {
  FiFolder, FiSearch, FiTerminal,
  FiGlobe, FiTool, FiChevronRight, FiChevronDown,
  FiCheck, FiX, FiLoader, FiClock,
} from 'react-icons/fi'
import { ToolCallDisplay as ToolCallDisplayType } from '../../types/chat'
import InlineDiff from './InlineDiff'
import { useProjectStore } from '../../stores/projectStore'
import { getFileIconUrl } from '@/utils/fileIcons'
import { relativeToProjectPath } from '@/utils/platform'
import { tokens } from '@/theme/tokens'
import { detectLanguage, highlightLines } from '@/utils/syntaxHighlight'
import { t } from '@/i18n'
import { isShellTool, ShellCommandBlock } from '../shell/ShellCommandBlock'
import { canonicalToolName, normalizeToolInputForCanonical } from '@/services/agent/toolNames'

interface ToolCallDisplayProps {
  toolCall: ToolCallDisplayType
}

const TOOL_ICONS: Record<string, React.ComponentType<{ size?: number | string }>> = {
  list_directory: FiFolder,
  search_files: FiSearch,
  glob: FiSearch,
  execute_command: FiTerminal,
  execute_command_background: FiTerminal,
  create_directory: FiFolder,
  web_fetch: FiGlobe,
  check_background_agents: FiSearch,
  check_background_commands: FiSearch,
}

/** Tools where we show a file-extension icon instead of the generic tool icon. */
const FILE_TOOLS = new Set(['read_file', 'read_around', 'write_file', 'edit_file', 'create_file', 'delete_file', 'rename_file'])

/** Human-readable tool labels shown in the chat UI. */
const TOOL_LABELS: Record<string, string> = {
  read_file: t('toolLabel.readingOutput'),
  read_around: t('toolLabel.readingOutput'),
  write_file: t('toolLabel.writing'),
  create_file: t('toolLabel.creating'),
  edit_file: t('toolLabel.editing'),
  delete_file: t('toolLabel.deleting'),
  rename_file: t('toolLabel.renaming'),
  list_directory: t('toolLabel.exploring'),
  create_directory: t('toolLabel.creatingFolder'),
  search_files: t('toolLabel.searching'),
  glob: t('toolLabel.findingFiles'),
  execute_command: t('toolLabel.run'),
  execute_command_background: t('toolLabel.backgroundCommand'),
  check_background_commands: t('toolLabel.checkingBackgroundCommands'),
  start_dev_server: t('toolLabel.startingServer'),
  stop_dev_server: t('toolLabel.stoppingServer'),
  read_dev_server_logs: t('toolLabel.readingLogs'),
  read_large_result: t('toolLabel.readingOutput'),
  web_fetch: t('toolLabel.fetching'),
  check_background_agents: t('toolLabel.checkingAgents'),
  update_tasks: t('toolLabel.updatingTasks'),
  request_thinking: t('toolLabel.activatingReasoning'),
  read_skill: t('toolLabel.loadingGuide'),
}

/**
 * Friendly, non-technical descriptions for each skill the agent might load.
 * Shown in the chat in place of the raw skill body (which contains internal
 * provider names and implementation notes the developer never needs). Keyed
 * by the skill's directory name.
 *
 * Default fallback for unknown skills: a generic "Loaded a TM Code guide"
 * label, so a future skill ships without leaking until this map is updated.
 */
const SKILL_DESCRIPTIONS: Record<string, string> = {
  'publish-backend': t('toolLabel.publishGuide'),
  'auth-proxy': t('toolLabel.authGuide'),
  'google-signin': t('toolLabel.googleGuide'),
  'frontend-design': t('toolLabel.designGuide'),
}

function describeSkill(name: string): string {
  return SKILL_DESCRIPTIONS[name] || t('toolLabel.genericGuide')
}

function getToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] || toolName
}

const PATH_INPUT_KEYS = new Set([
  'file_path',
  'path',
  'directory',
  'cwd',
  'oldPath',
  'old_path',
  'newPath',
  'new_path',
])

function inputForDisplay(value: unknown, projectPath?: string | null, key?: string): unknown {
  if (typeof value === 'string') {
    return key && PATH_INPUT_KEYS.has(key)
      ? relativeToProjectPath(value, projectPath)
      : value
  }
  if (Array.isArray(value)) {
    return value.map(item => inputForDisplay(item, projectPath))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([entryKey, entryValue]) => [entryKey, inputForDisplay(entryValue, projectPath, entryKey)]),
    )
  }
  return value
}

// Exported for ExplorationBatch — the group header shows the live target
// ("⎿ src/stores/chatStore.ts") using the same summary the individual row
// would have shown, so collapsed and expanded views always agree.
export function getInputSummary(
  toolName: string,
  input: Record<string, unknown>,
  result?: string,
  projectPath?: string | null,
): string {
  const displayPath = (p: string) => relativeToProjectPath(p, projectPath)
  // Resolver: new tool calls use file_path, old sessions (pre-rename) use path.
  const fp = String(input.file_path || input.path || '')

  switch (toolName) {
    case 'read_file':
    case 'read_around':
      return displayPath(fp)
    case 'write_file':
    case 'create_file':
      return displayPath(fp)
    case 'edit_file':
      return displayPath(fp)
    case 'delete_file':
      return displayPath(fp)
    case 'rename_file':
      return `${displayPath(String(input.oldPath || input.old_path || ''))} → ${input.newName || displayPath(String(input.newPath || input.new_path || ''))}`
    case 'list_directory':
      return displayPath(fp) || 'project'
    case 'create_directory':
      return displayPath(fp)
    case 'search_files':
      return `"${input.query}"`
    case 'execute_command': {
      const cmd = String(input.command || '')
      return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
    }
    case 'execute_command_background': {
      const cmd = String(input.command || '')
      return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
    }
    case 'check_background_commands':
      return input.id ? String(input.id) : ''
    case 'start_dev_server': {
      const type = input.server_type === 'backend' ? 'backend' : 'frontend'
      return `${type} server`
    }
    case 'stop_dev_server':
      return 'dev server'
    case 'read_dev_server_logs':
      return `last ${input.lines || 50} lines`
    case 'glob':
      return String(input.pattern || '')
    case 'web_fetch':
      return String(input.url || '').replace(/^https?:\/\//, '').slice(0, 50)
    case 'check_background_agents':
      return ''
    case 'update_tasks': {
      // update_tasks uses patch semantics: input.tasks is only the patch the
      // agent just sent, not the full tracker. For completed calls, prefer the
      // executor's post-merge result so this row agrees with AgentTasksPanel.
      const mergedProgress = result?.match(/Task list updated:\s+(\d+\/\d+ completed)\./)
      if (mergedProgress) return mergedProgress[1]

      // input.tasks comes from streaming JSON — during partial parse it can be
      // a truthy non-array (e.g. an empty object or a string mid-deserialization).
      // The previous `if (tasks)` guard was permissive enough to fall through
      // and call .filter on a non-array, crashing the React tree.
      const tasks = input.tasks
      if (Array.isArray(tasks)) {
        return `${tasks.length} ${tasks.length === 1 ? 'update' : 'updates'}`
      }
      return ''
    }
    case 'request_thinking':
      return 'deep reasoning mode'
    case 'read_skill':
      // User-facing summary — never the raw skill content, which contains
      // provider names and implementation details that aren't useful to
      // surface in the chat. The agent has the body in its context.
      return describeSkill(String(input.name || ''))
    default: {
      // MCP tools: show just the tool name part
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__')
        return parts[2] || toolName
      }
      return JSON.stringify(inputForDisplay(input, projectPath)).slice(0, 50)
    }
  }
}

function isWriteTool(toolName: string): boolean {
  return toolName === 'write_file' || toolName === 'edit_file' || toolName === 'create_file'
}

// As tools `research`, `verify` e `spawn_background_agent` foram substituídas
// pelo `delegate` (v0.7.0) e a última — `verify` — saiu do executor a
// 2026-07-30. O `delegate` NÃO entra aqui: ele devolve de imediato e o
// resultado do sub-agente é entregue à parte (SubAgentCard), portanto o seu
// painel de resultado não duplica nada e deve continuar visível.

function ToolCallDisplayComponent({ toolCall }: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false)
  const projectPath = useProjectStore(s => s.currentProject?.path || '')
  const displayToolName = canonicalToolName(toolCall.toolName)
  const displayInput = normalizeToolInputForCanonical(toolCall.toolName, toolCall.input)
  const filePath = (displayInput?.file_path || displayInput?.path || displayInput?.oldPath || '') as string
  const useFileIcon = FILE_TOOLS.has(displayToolName) && !!filePath
  const IconComponent = TOOL_ICONS[displayToolName] || FiTool
  const inputSummary = getInputSummary(displayToolName, displayInput, toolCall.result, projectPath)
  // A tool call streams in with status:'running', but the serial tool loop
  // starts calls one at a time and can pause on each diff approval. `started`
  // (set on onToolCallStart, i.e. the moment a call's execute() begins)
  // separates the one actually running from those still waiting; without it
  // every queued edit shows an active spinner and reads as parallel writes.
  const isQueued = toolCall.status === 'running' && toolCall.started !== true
  const isRunning = toolCall.status === 'running' && toolCall.started === true
  const isFailed = toolCall.status === 'failed'
  const isCompleted = toolCall.status === 'completed'
  const isNested = !!toolCall.spawnedBy

  if (isShellTool(toolCall.toolName)) {
    return (
      <ShellCommandBlock
        toolCall={toolCall}
        mode="chat"
        nested={isNested}
      />
    )
  }

  const hasDiff = toolCall.diffNewContent !== undefined && isWriteTool(displayToolName)

  // Result text (moved before hooks to avoid conditional hook calls)
  const resultText = toolCall.result || ''

  // Syntax-highlight read_file output
  const readFileLang = displayToolName === 'read_file' ? detectLanguage(String(displayInput.file_path || displayInput.path || '')) : null
  const highlightedOutput = useMemo(() => {
    if (!readFileLang || !resultText) return null
    return highlightLines(resultText, readFileLang)
  }, [readFileLang, resultText])

  // Sub-agent tool calls carry a spawnedBy id — nest them visually under the
  // research/verify/bg launcher so the user sees the full activity hierarchy.
  const nestedProps = isNested
    ? { ml: 4, pl: 2, borderLeft: `2px solid ${tokens.colors.accent.purple}` } as const
    : {}

  // Render inline diff for write tools
  if (isCompleted && hasDiff) {
    return (
      <Box my={2} data-tool-call-id={toolCall.id} {...nestedProps}>
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
            {getToolLabel(displayToolName)}
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
        {/* Enquanto a decisão está PENDENTE, o diff vive no painel de
            aprovação (DiffApprovalPanel), com a lista de ficheiros e os
            botões. Repeti-lo aqui mostrava o MESMO diff duas vezes no ecrã e
            empurrava o painel para fora da vista. Decidido, o cartão volta a
            ser o registo permanente no transcript. */}
        {toolCall.diffStatus === 'pending' ? (
          <Text
            px={1}
            fontSize="11px"
            color={tokens.colors.text.disabled}
            fontFamily={tokens.fontFamily.mono}
          >
            {t('diffBar.underReview')}
          </Text>
        ) : (
          <InlineDiff
            filePath={filePath}
            oldContent={toolCall.diffOldContent || ''}
            newContent={toolCall.diffNewContent || ''}
            isNewFile={toolCall.isNewFile || false}
            status={toolCall.diffStatus || 'pending'}
          />
        )}
      </Box>
    )
  }

  // read_skill body carries platform/provider names + implementation
  // details aimed at the agent. Render the friendly description in the
  // header (via getInputSummary) and keep the body hidden — no expand
  // chevron, no markdown preview.
  const isSkillRead = displayToolName === 'read_skill'

  // Standard tool call rendering
  const resultLines = resultText.split('\n')
  const hasOutput = resultText.length > 0 && !isRunning && !isSkillRead
  const showExpand = resultLines.length > 4 && !expanded

  // For execute_command, surface the full command on expand. The header
  // summary truncates at 60 chars so long commands get '…' — the expand
  // chevron is the only way to see what actually ran. Available even while
  // running, so the user can audit the command in flight.
  const fullCommand = displayToolName === 'execute_command'
    ? String(displayInput.command || '')
    : ''
  const showFullCommand = fullCommand.length > 0
    && (fullCommand.length > 60 || isRunning || isFailed)
  const canExpand = hasOutput || showFullCommand
  const displayResult = showExpand ? resultLines.slice(0, 4).join('\n') : resultText

  return (
    <Box
      borderRadius="8px"
      overflow="hidden"
      my={1.5}
      border={`1px solid ${isRunning ? 'rgba(240, 192, 0, 0.12)' : isFailed ? 'rgba(248, 81, 73, 0.12)' : 'rgba(255, 255, 255, 0.04)'}`}
      bg={isRunning ? 'rgba(240, 192, 0, 0.03)' : isFailed ? 'rgba(248, 81, 73, 0.03)' : 'rgba(255, 255, 255, 0.015)'}
      transition="all 0.15s"
      {...nestedProps}
    >
      {/* Header row */}
      <Flex
        align="center"
        gap={2}
        px={3}
        py="8px"
        cursor={canExpand ? 'pointer' : 'default'}
        _hover={canExpand ? { bg: 'rgba(255, 255, 255, 0.02)' } : undefined}
        transition="background 0.1s"
        onClick={() => { if (canExpand) setExpanded(!expanded) }}
      >
        {/* Status indicator */}
        {isQueued ? (
          // Waiting for the serial executor — static clock, no spinner, so it
          // reads as queued rather than actively editing now.
          <Box color={tokens.colors.text.disabled} flexShrink={0}>
            <FiClock size={12} />
          </Box>
        ) : isRunning ? (
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

        {/* Tool name — queued calls read "Queued · <action>" in a muted tone
            so a stack of edits awaiting approval doesn't look like parallel
            work in flight. */}
        <Text
          color={isQueued ? tokens.colors.text.disabled : tokens.colors.text.secondary}
          fontFamily={tokens.fontFamily.mono}
          fontSize="12px"
          flexShrink={0}
          fontWeight="500"
        >
          {isQueued ? `${t('toolLabel.queued')} · ${getToolLabel(displayToolName)}` : getToolLabel(displayToolName)}
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
        {canExpand && (
          <Box color={tokens.colors.text.disabled} flexShrink={0} transition="transform 0.15s">
            {expanded ? <FiChevronDown size={13} /> : <FiChevronRight size={13} />}
          </Box>
        )}
      </Flex>

      {/* Expanded full command — shown for execute_command regardless of
          running/completed state so the user can audit long commands that
          the header summary truncates at 60 chars. */}
      {expanded && showFullCommand && (
        <Box
          px={3}
          py="8px"
          borderTop={`1px solid rgba(255, 255, 255, 0.04)`}
          bg="rgba(0, 0, 0, 0.18)"
          maxH="160px"
          overflowY="auto"
          css={{
            '&::-webkit-scrollbar': { width: '4px', height: '4px' },
            '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.1)', borderRadius: '2px' },
          }}
        >
          <Text
            fontSize="11px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.text.secondary}
            whiteSpace="pre-wrap"
            wordBreak="break-all"
            lineHeight="1.55"
            userSelect="text"
            data-selectable="true"
          >
            {fullCommand}
          </Text>
        </Box>
      )}

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
