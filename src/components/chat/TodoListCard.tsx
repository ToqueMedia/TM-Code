import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiPlay, FiFileText, FiCheckSquare, FiSquare } from 'react-icons/fi'
import { invoke } from '@tauri-apps/api/core'
import { useEditorRepository } from '../../stores/editorStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { handleStartExecution } from '../../services/agent/commands/planCommand'
import { useChatStore } from '../../stores/chatStore'
import { computeSlidingWindow } from '../../utils/taskWindow'
import { tokens } from '@/theme/tokens'
import type { ChatMessageCard } from '../../types/chat'

interface TodoTask {
  text: string
  isPhaseHeader: boolean
  completed: boolean
}

interface TodoListCardProps {
  card: ChatMessageCard
}

function TodoListCard({ card }: TodoListCardProps) {
  const { projectPath, status } = card
  const isStreaming = useChatStore(s => s.isStreaming)
  const [tasks, setTasks] = useState<TodoTask[]>([])
  const [loading, setLoading] = useState(true)
  const prevStreamingRef = useRef(isStreaming)

  // Load tasks on mount
  useEffect(() => {
    loadTasks(projectPath).then(t => {
      setTasks(t)
      setLoading(false)
    })
  }, [projectPath])

  // Reload tasks when streaming ends (agent may have updated TODO.md)
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      loadTasks(projectPath).then(setTasks)
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming, projectPath])

  const handleStart = useCallback(async () => {
    await handleStartExecution(projectPath)
  }, [projectPath])

  const handleViewTodo = useCallback(() => {
    const editorStore = useEditorRepository.getState()
    editorStore.openFile(`${projectPath}/TODO.md`)
    useLayoutStore.getState().setViewMode('editor')
  }, [projectPath])

  const completedCount = tasks.filter(t => !t.isPhaseHeader && t.completed).length
  const totalCount = tasks.filter(t => !t.isPhaseHeader).length

  // Auto-collapse to a one-line badge when the plan is fully executed and the
  // agent has finished streaming. Rationale: the assistant's accompanying
  // summary message already describes what was done — keeping the full task
  // list expanded duplicates that information and pushes the summary off-screen.
  // We don't return null entirely so scrolling back through history still
  // shows that a plan ran (and clicking opens TODO.md for the full record).
  const allComplete = !loading && totalCount > 0 && completedCount === totalCount
  const collapsed = allComplete && !isStreaming

  if (collapsed) {
    return (
      <Flex
        as="button"
        align="center"
        gap="6px"
        px={3}
        py="6px"
        my={2}
        borderRadius="8px"
        bg="rgba(46, 160, 67, 0.08)"
        border="1px solid rgba(46, 160, 67, 0.18)"
        cursor="pointer"
        transition="all 0.15s"
        _hover={{ bg: 'rgba(46, 160, 67, 0.12)' }}
        onClick={handleViewTodo}
      >
        <FiCheckSquare size={12} color={tokens.colors.accent.greenBright} />
        <Text fontSize="12px" color={tokens.colors.accent.greenBright} fontWeight="500">
          Plan complete — {totalCount} {totalCount === 1 ? 'task' : 'tasks'}
        </Text>
        <Text fontSize="11px" color={tokens.colors.text.muted}>
          · View TODO.md
        </Text>
      </Flex>
    )
  }

  return (
    <Box
      bg="rgba(255, 255, 255, 0.03)"
      border="1px solid rgba(255, 255, 255, 0.08)"
      borderRadius="12px"
      p={4}
      my={2}
    >
      {/* Header */}
      <Flex align="center" gap={2} mb={3}>
        <Flex
          w="24px"
          h="24px"
          borderRadius="6px"
          bg="rgba(46, 160, 67, 0.15)"
          align="center"
          justify="center"
          flexShrink={0}
        >
          <FiCheckSquare size={12} color={tokens.colors.accent.greenBright} />
        </Flex>
        <Text
          fontSize="13.5px"
          fontWeight="600"
          color={tokens.colors.text.primary}
          letterSpacing="-0.01em"
        >
          Development Plan
          {!loading && ` (${completedCount}/${totalCount} tasks)`}
        </Text>
      </Flex>

      {/* Task list — short 3-task window. Compact by design; the user opens
          TODO.md (button below) when they want the full list. The window
          slides so the in-progress task is always visible: at the top of
          the list at first ([0,1,2]), then shifts forward as the agent
          checks off completed tasks so the active row stays the bottom of
          the window ([N-2, N-1, N]). Phase headers are dropped from the
          window — they're structural and bloat 3 slots — but the task
          IDs (e.g. "Task 1.1") already encode the phase. */}
      {loading ? (
        <Text fontSize="12px" color={tokens.colors.text.muted} py={2}>Loading tasks...</Text>
      ) : (() => {
        const realTasks = tasks.filter(t => !t.isPhaseHeader)
        if (realTasks.length === 0) {
          return <Text fontSize="12px" color={tokens.colors.text.muted} py={2}>No tasks parsed from TODO.md.</Text>
        }

        // In-progress = first non-completed task. Heuristic, but matches the
        // pattern the implementation agent uses (it works through tasks in
        // order and marks each completed before moving to the next).
        // `-1` falls through to the "all complete → show tail" branch in
        // computeSlidingWindow (anchor at last index).
        const inProgressIdx = realTasks.findIndex(t => !t.completed)
        const { start: startIdx, end: endIdx, hiddenAbove, hiddenBelow } =
          computeSlidingWindow(realTasks.length, inProgressIdx)
        const window = realTasks.slice(startIdx, endIdx + 1)

        return (
          <Box mb={3}>
            {hiddenAbove > 0 && (
              <Text fontSize="11px" color={tokens.colors.text.disabled} px={2} mb="2px">
                · {hiddenAbove} earlier {hiddenAbove === 1 ? 'task' : 'tasks'}
              </Text>
            )}
            {window.map((task, i) => {
              const absoluteIdx = startIdx + i
              const isInProgress = absoluteIdx === inProgressIdx
              const color = task.completed
                ? tokens.colors.text.muted
                : isInProgress
                  ? tokens.colors.accent.blueBright
                  : tokens.colors.text.primary
              const iconColor = task.completed
                ? tokens.colors.accent.greenBright
                : isInProgress
                  ? tokens.colors.accent.blueBright
                  : tokens.colors.text.disabled
              return (
                <Flex
                  key={absoluteIdx}
                  gap="6px"
                  py="3px"
                  pl={2}
                  align="flex-start"
                  // Subtle left accent so the in-progress row reads as
                  // "where the agent is right now" at a glance.
                  borderLeft={isInProgress ? `2px solid ${tokens.colors.accent.blueBright}` : '2px solid transparent'}
                >
                  {task.completed ? (
                    <FiCheckSquare size={13} color={iconColor} style={{ marginTop: '2px', flexShrink: 0 }} />
                  ) : isInProgress ? (
                    <FiPlay size={11} color={iconColor} style={{ marginTop: '3px', flexShrink: 0 }} />
                  ) : (
                    <FiSquare size={13} color={iconColor} style={{ marginTop: '2px', flexShrink: 0 }} />
                  )}
                  <Text
                    fontSize="12.5px"
                    color={color}
                    lineHeight="1.5"
                    fontWeight={isInProgress ? '500' : '400'}
                    textDecoration={task.completed ? 'line-through' : 'none'}
                  >
                    {task.text}
                  </Text>
                </Flex>
              )
            })}
            {hiddenBelow > 0 && (
              <Text fontSize="11px" color={tokens.colors.text.disabled} px={2} mt="2px">
                · {hiddenBelow} more {hiddenBelow === 1 ? 'task' : 'tasks'}
              </Text>
            )}
          </Box>
        )
      })()}

      {/* Action buttons */}
      <Flex gap={2} flexWrap="wrap">
        {status === 'pending' && (
          <Flex
            as="button"
            align="center"
            gap="5px"
            px={3}
            py="7px"
            borderRadius="8px"
            bg="rgba(37, 99, 235, 0.12)"
            border="1px solid rgba(37, 99, 235, 0.25)"
            cursor={isStreaming ? 'default' : 'pointer'}
            transition="all 0.15s"
            opacity={isStreaming ? 0.4 : 1}
            pointerEvents={isStreaming ? 'none' : 'auto'}
            _hover={!isStreaming ? { bg: 'rgba(37, 99, 235, 0.2)' } : undefined}
            onClick={handleStart}
          >
            <FiPlay size={11} color={tokens.colors.accent.blueBright} />
            <Text fontSize="12px" color={tokens.colors.accent.blueBright} fontWeight="500">
              Start Execution
            </Text>
          </Flex>
        )}

        <Flex
          as="button"
          align="center"
          gap="5px"
          px={3}
          py="7px"
          borderRadius="8px"
          bg="rgba(255, 255, 255, 0.05)"
          border="1px solid rgba(255, 255, 255, 0.08)"
          cursor="pointer"
          transition="all 0.15s"
          _hover={{ bg: 'rgba(255, 255, 255, 0.08)' }}
          onClick={handleViewTodo}
        >
          <FiFileText size={12} color={tokens.colors.text.secondary} />
          <Text fontSize="12px" color={tokens.colors.text.primary}>
            View TODO.md
          </Text>
        </Flex>
      </Flex>
    </Box>
  )
}

async function loadTasks(projectPath: string): Promise<TodoTask[]> {
  try {
    const content = await invoke<string>('read_file', {
      path: `${projectPath}/TODO.md`
    })

    const tasks: TodoTask[] = []

    for (const line of content.split('\n')) {
      const trimmed = line.trim()

      // Phase header: "## Phase 1 — ..."
      if (trimmed.startsWith('## Phase')) {
        tasks.push({ text: trimmed.replace('## ', ''), isPhaseHeader: true, completed: false })
        continue
      }

      // Task: "- [ ] **Task 1.1:** ..." or "- [x] **Task 1.1:** ..."
      const taskMatch = trimmed.match(/^- \[([ x])\] \*\*(.+?)\*\*:?\s*(.*)/)
      if (taskMatch) {
        const completed = taskMatch[1] === 'x'
        const taskText = `${taskMatch[2]} ${taskMatch[3]}`.trim()
        tasks.push({ text: taskText, isPhaseHeader: false, completed })
      }
    }

    return tasks
  } catch {
    return []
  }
}

export default memo(TodoListCard)
