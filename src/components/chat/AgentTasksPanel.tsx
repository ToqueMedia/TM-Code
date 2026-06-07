import { memo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiCheck, FiLoader, FiChevronDown, FiChevronUp, FiCheckSquare, FiX, FiAlertCircle, FiMaximize2, FiMinimize2 } from 'react-icons/fi'
import { useAgentStore, type AgentTask } from '../../stores/agentStore'
import { computeSlidingWindow } from '../../utils/taskWindow'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'

/**
 * Persistent panel that mirrors the agent's `update_tasks` state — the same
 * data CMD mode renders above its status bar (`TerminalStatusLine`). Lives
 * inside `PromptBar`, above the queued-messages strip, so the developer
 * always sees what the agent is currently working on without scrolling.
 *
 * Design choices:
 *   - Hidden when the task list is empty so it doesn't take up vertical
 *     real estate on every prompt.
 *   - Collapsible — long lists from /plan-style breakdowns shouldn't push
 *     the input off-screen on small windows.
 *   - Expandable — the 3-task sliding window can be toggled to show ALL
 *     tasks, so the developer can review the full plan without leaving
 *     the chat. The "· N more tasks" label is clickable and doubles as
 *     the expand affordance.
 *   - Status icons match CMD mode for visual consistency: spinner during
 *     in_progress, checkmark on done, dot for pending.
 *   - All user-facing strings use i18n via useTranslation().
 */
function AgentTasksPanel() {
  const tasks = useAgentStore(s => s.tasks)
  const t = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const [expanded, setExpanded] = useState(false)

  if (tasks.length === 0) return null

  const completed = tasks.filter(t2 => t2.status === 'completed').length
  const failed = tasks.filter(t2 => t2.status === 'failed').length
  const cancelled = tasks.filter(t2 => t2.status === 'cancelled').length
  const total = tasks.length
  // Terminal states: all tasks are completed, failed, or cancelled (no pending/in_progress)
  const allDone = tasks.every(t2 => t2.status === 'completed' || t2.status === 'failed' || t2.status === 'cancelled')

  // Auto-hide once every task is in a terminal state. The panel disappears
  // immediately when all tasks are done — no need to wait for streaming to end.
  // The list isn't cleared from the store on purpose — the next agent turn
  // starts by calling `clearTasks()` (agentService.ts), so the record stays
  // available for export/inspection until that point. We just stop occupying
  // vertical real estate above the prompt.
  if (allDone) return null

  const headerLabel = `${t('tasks.label')} ${completed}/${total}${
    failed > 0 ? ` · ${failed} ${t('tasks.failed')}` : ''
  }${
    cancelled > 0 ? ` · ${cancelled} ${t('tasks.cancelled')}` : ''
  }`

  return (
    <Box
      mb={2}
      bg="rgba(255, 255, 255, 0.025)"
      border="1px solid rgba(255, 255, 255, 0.06)"
      borderRadius="10px"
      overflow="hidden"
    >
      {/* Header — click to collapse/expand row */}
      <Flex
        align="center"
        gap={2}
        px={3}
        py={2}
        cursor="pointer"
        onClick={() => setCollapsed(c => !c)}
        _hover={{ bg: 'rgba(255, 255, 255, 0.02)' }}
        transition={`background ${tokens.transition.fast}`}
      >
        <FiCheckSquare
          size={12}
          color={allDone ? tokens.colors.accent.greenBright : tokens.colors.accent.primary}
          style={{ flexShrink: 0 }}
        />
        <Text
          fontSize="11px"
          fontWeight="600"
          color={tokens.colors.text.secondary}
          textTransform="uppercase"
          letterSpacing="0.05em"
          flex={1}
        >
          {headerLabel}
        </Text>
        {/* Expand/collapse toggle — only shown when tasks > 3 */}
        {tasks.length > 3 && !collapsed && (
          <button
            type="button"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation()
              setExpanded(v => !v)
            }}
            aria-label={expanded ? t('tasks.collapse') : t('tasks.expand')}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '2px',
              borderRadius: '4px',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              transition: tokens.transition.fast,
            }}
            onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255, 255, 255, 0.06)'
            }}
            onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            }}
          >
            {expanded
              ? <FiMinimize2 size={11} color={tokens.colors.text.disabled} />
              : <FiMaximize2 size={11} color={tokens.colors.text.disabled} />
            }
          </button>
        )}
        {collapsed ? (
          <FiChevronDown size={12} color={tokens.colors.text.disabled} />
        ) : (
          <FiChevronUp size={12} color={tokens.colors.text.disabled} />
        )}
      </Flex>

      {/* Task list */}
      {!collapsed && (() => {
        // When expanded, show ALL tasks. Otherwise, use the 3-task
        // sliding window anchored on in_progress / failed / pending.
        if (expanded) {
          return (
            <Box px={3} pb={2.5} maxH="240px" overflowY="auto">
              {tasks.map((task: AgentTask) => (
                <Flex key={task.id} align="flex-start" gap={2} py="3px">
                  <Box mt="2px" flexShrink={0}>
                    <StatusIcon status={task.status} />
                  </Box>
                  <TaskText task={task} />
                </Flex>
              ))}
            </Box>
          )
        }

        const inProgressIdx = tasks.findIndex(t2 => t2.status === 'in_progress')
        const firstPendingIdx = tasks.findIndex(t2 => t2.status === 'pending')
        const firstFailedIdx = tasks.findIndex(t2 => t2.status === 'failed')
        // Anchor: prefer in-progress (explicit status from update_tasks);
        // else first failed (user needs to see what went wrong);
        // else first pending; else fall back to "show tail" (all complete
        // → recap last 3). Distinct from TodoListCard's "first non-completed"
        // because here we have an explicit `in_progress` field — preferring it
        // tracks the agent's own claim about what it's working on rather than
        // inferring from completion order.
        const anchorIdx =
          inProgressIdx !== -1 ? inProgressIdx
          : firstFailedIdx !== -1 ? firstFailedIdx
          : firstPendingIdx !== -1 ? firstPendingIdx
          : -1 // helper handles -1 → show tail
        const { start: startIdx, end: endIdx, hiddenAbove, hiddenBelow } =
          computeSlidingWindow(tasks.length, anchorIdx)
        const visible = tasks.slice(startIdx, endIdx + 1)

        return (
          <Box px={3} pb={2.5}>
            {hiddenAbove > 0 && (
              <Text fontSize="10px" color={tokens.colors.text.disabled} py="2px">
                · {hiddenAbove} {t('tasks.earlier')} {hiddenAbove === 1 ? t('tasks.taskSingular') : t('tasks.taskPlural')}
              </Text>
            )}
            {visible.map((task: AgentTask) => (
              <Flex key={task.id} align="flex-start" gap={2} py="3px">
                <Box mt="2px" flexShrink={0}>
                  <StatusIcon status={task.status} />
                </Box>
                <TaskText task={task} />
              </Flex>
            ))}
            {hiddenBelow > 0 && (
              <Text
                fontSize="10px"
                color={tokens.colors.text.disabled}
                py="2px"
                cursor="pointer"
                onClick={() => setExpanded(true)}
                _hover={{ color: tokens.colors.text.secondary }}
                transition={`color ${tokens.transition.fast}`}
              >
                · {hiddenBelow} {t('tasks.more')} {hiddenBelow === 1 ? t('tasks.taskSingular') : t('tasks.taskPlural')} →
              </Text>
            )}
          </Box>
        )
      })()}
    </Box>
  )
}

/** Task description text with status-dependent styling. */
function TaskText({ task }: { task: AgentTask }) {
  return (
    <Text
      fontSize="12px"
      color={task.status === 'completed'
        ? tokens.colors.text.disabled
        : task.status === 'in_progress'
          ? tokens.colors.text.primary
          : task.status === 'failed'
            ? tokens.colors.accent.red
            : task.status === 'cancelled'
              ? tokens.colors.text.disabled
              : tokens.colors.text.secondary}
      textDecoration={task.status === 'completed' || task.status === 'cancelled' ? 'line-through' : 'none'}
      fontWeight={task.status === 'in_progress' ? 500 : 400}
      lineHeight="1.45"
      opacity={task.status === 'cancelled' ? 0.5 : 1}
    >
      {task.description}
    </Text>
  )
}

function StatusIcon({ status }: { status: AgentTask['status'] }) {
  if (status === 'completed') {
    return <FiCheck size={11} color={tokens.colors.accent.green} />
  }
  if (status === 'in_progress') {
    return (
      <Box
        as={FiLoader}
        boxSize="11px"
        color={tokens.colors.accent.primary}
        css={{
          animation: 'agentTaskSpin 1.4s linear infinite',
          '@keyframes agentTaskSpin': {
            '0%': { transform: 'rotate(0deg)' },
            '100%': { transform: 'rotate(360deg)' },
          },
        }}
      />
    )
  }
  if (status === 'failed') {
    return <FiAlertCircle size={11} color={tokens.colors.accent.red} />
  }
  if (status === 'cancelled') {
    return <FiX size={11} color={tokens.colors.text.disabled} />
  }
  return (
    <Box
      w="11px"
      h="11px"
      display="flex"
      alignItems="center"
      justifyContent="center"
    >
      <Box w="4px" h="4px" borderRadius="full" bg={tokens.colors.text.disabled} />
    </Box>
  )
}

export default memo(AgentTasksPanel)