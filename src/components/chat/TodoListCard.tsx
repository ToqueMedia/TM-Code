import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiPlay, FiFileText, FiCheckSquare, FiSquare } from 'react-icons/fi'
import { invoke } from '@tauri-apps/api/core'
import { useEditorRepository } from '../../stores/editorStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { handleStartExecution } from '../../services/agent/commands/planCommand'
import { useChatStore } from '../../stores/chatStore'
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

      {/* Task list */}
      {loading ? (
        <Text fontSize="12px" color={tokens.colors.text.muted} py={2}>Loading tasks...</Text>
      ) : (
        <Box
          maxH="300px"
          overflowY="auto"
          mb={3}
          css={{
            '&::-webkit-scrollbar': { width: '4px' },
            '&::-webkit-scrollbar-thumb': {
              background: tokens.colors.scrollbar.thumb,
              borderRadius: '4px',
            },
          }}
        >
          {tasks.map((task, index) => {
            if (task.isPhaseHeader) {
              return (
                <Text
                  key={index}
                  fontSize="12px"
                  fontWeight="600"
                  color={tokens.colors.accent.purple}
                  mt={index > 0 ? 3 : 0}
                  mb="6px"
                  letterSpacing="-0.005em"
                >
                  {task.text}
                </Text>
              )
            }

            return (
              <Flex key={index} gap="6px" py="3px" pl={2} align="flex-start">
                {task.completed ? (
                  <FiCheckSquare size={13} color={tokens.colors.accent.greenBright} style={{ marginTop: '2px', flexShrink: 0 }} />
                ) : (
                  <FiSquare size={13} color={tokens.colors.text.disabled} style={{ marginTop: '2px', flexShrink: 0 }} />
                )}
                <Text
                  fontSize="12.5px"
                  color={task.completed ? tokens.colors.text.muted : tokens.colors.text.primary}
                  lineHeight="1.5"
                  textDecoration={task.completed ? 'line-through' : 'none'}
                >
                  {task.text}
                </Text>
              </Flex>
            )
          })}
        </Box>
      )}

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
