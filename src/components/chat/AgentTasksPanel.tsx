import { memo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiCheck, FiLoader, FiChevronDown, FiChevronUp, FiCheckSquare } from 'react-icons/fi'
import { useAgentStore, type AgentTask } from '../../stores/agentStore'
import { tokens } from '@/theme/tokens'

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
 *   - Status icons match CMD mode for visual consistency: spinner during
 *     in_progress, checkmark on done, dot for pending.
 */
function AgentTasksPanel() {
  const tasks = useAgentStore(s => s.tasks)
  const [collapsed, setCollapsed] = useState(false)

  if (tasks.length === 0) return null

  const completed = tasks.filter(t => t.status === 'completed').length
  const total = tasks.length
  const allDone = completed === total

  return (
    <Box
      mb={2}
      bg="rgba(255, 255, 255, 0.025)"
      border="1px solid rgba(255, 255, 255, 0.06)"
      borderRadius="10px"
      overflow="hidden"
    >
      {/* Header — click to collapse */}
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
          Tasks {completed}/{total}
        </Text>
        {collapsed ? (
          <FiChevronDown size={12} color={tokens.colors.text.disabled} />
        ) : (
          <FiChevronUp size={12} color={tokens.colors.text.disabled} />
        )}
      </Flex>

      {/* Task list */}
      {!collapsed && (
        <Box px={3} pb={2.5} maxH="180px" overflowY="auto" css={{
          '&::-webkit-scrollbar': { width: '3px' },
          '&::-webkit-scrollbar-thumb': {
            background: tokens.colors.border.panel,
            borderRadius: '2px',
          },
        }}>
          {tasks.map((task: AgentTask) => (
            <Flex key={task.id} align="flex-start" gap={2} py="3px">
              <Box mt="2px" flexShrink={0}>
                <StatusIcon status={task.status} />
              </Box>
              <Text
                fontSize="12px"
                color={task.status === 'completed'
                  ? tokens.colors.text.disabled
                  : task.status === 'in_progress'
                    ? tokens.colors.text.primary
                    : tokens.colors.text.secondary}
                textDecoration={task.status === 'completed' ? 'line-through' : 'none'}
                fontWeight={task.status === 'in_progress' ? 500 : 400}
                lineHeight="1.45"
              >
                {task.description}
              </Text>
            </Flex>
          ))}
        </Box>
      )}
    </Box>
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
