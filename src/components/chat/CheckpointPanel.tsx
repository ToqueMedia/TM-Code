import { memo, useState, useCallback, useEffect } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import {
  FiRotateCcw, FiChevronDown, FiChevronRight, FiClock,
  FiFile, FiFilePlus, FiTrash2, FiEdit3, FiGitCommit
} from 'react-icons/fi'
import { useCheckpointStore } from '../../stores/checkpointStore'
import { useChatStore } from '../../stores/chatStore'
import { tokens } from '@/theme/tokens'

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

const operationIcons: Record<string, typeof FiFile> = {
  write: FiEdit3,
  create: FiFilePlus,
  delete: FiTrash2,
  rename: FiEdit3,
}

const operationColors: Record<string, string> = {
  write: tokens.colors.accent.orange,
  create: tokens.colors.accent.green,
  delete: tokens.colors.accent.red,
  rename: tokens.colors.accent.purple,
}

function CheckpointPanel() {
  const checkpoints = useCheckpointStore(s => s.checkpoints)
  const isReverting = useCheckpointStore(s => s.isReverting)
  const revertToCheckpoint = useCheckpointStore(s => s.revertToCheckpoint)
  const revertLast = useCheckpointStore(s => s.revertLast)
  const lastRevertedPaths = useCheckpointStore(s => s.lastRevertedPaths)
  const clearLastRevertedPaths = useCheckpointStore(s => s.clearLastRevertedPaths)
  const sessionDiff = useCheckpointStore(s => s.sessionDiff)
  const isLoadingDiff = useCheckpointStore(s => s.isLoadingDiff)
  const loadSessionDiff = useCheckpointStore(s => s.loadSessionDiff)
  const isStreaming = useChatStore(s => s.isStreaming)
  const [isExpanded, setIsExpanded] = useState(false)
  const [showSessionDiff, setShowSessionDiff] = useState(false)
  const [confirmRevertId, setConfirmRevertId] = useState<string | null>(null)
  const [, setTick] = useState(0)

  // Add system message to chat after revert (avoids circular import in store)
  useEffect(() => {
    if (lastRevertedPaths.length === 0) return
    const names = lastRevertedPaths.map(p => p.split('/').pop()).filter(Boolean)
    const msg = names.length === 1
      ? `Reverted: ${names[0]}`
      : `Reverted ${names.length} files: ${names.join(', ')}`
    useChatStore.getState().addSystemMessage(msg)
    clearLastRevertedPaths()
  }, [lastRevertedPaths, clearLastRevertedPaths])

  // Clear stale confirmation when checkpoints change
  useEffect(() => {
    if (confirmRevertId && !checkpoints.some(cp => cp.id === confirmRevertId)) {
      setConfirmRevertId(null)
    }
  }, [checkpoints, confirmRevertId])

  // Refresh timestamps every 30s
  useEffect(() => {
    if (checkpoints.length === 0) return
    const timer = setInterval(() => setTick(t => t + 1), 30_000)
    return () => clearInterval(timer)
  }, [checkpoints.length])

  const disabled = isStreaming || isReverting

  const handleRevertLast = useCallback(async () => {
    // Read fresh state to prevent double-click race (closure may be stale)
    const { isReverting: busy } = useCheckpointStore.getState()
    if (isStreaming || busy || checkpoints.length === 0) return
    await revertLast()
  }, [isStreaming, checkpoints.length, revertLast])

  const handleRevertClick = useCallback(async (checkpointId: string, isLast: boolean) => {
    const { isReverting: busy } = useCheckpointStore.getState()
    if (isStreaming || busy) return
    if (isLast) {
      await revertToCheckpoint(checkpointId)
    } else {
      setConfirmRevertId(checkpointId)
    }
  }, [isStreaming, revertToCheckpoint])

  const handleConfirmRevert = useCallback(async () => {
    const { isReverting: busy } = useCheckpointStore.getState()
    if (!confirmRevertId || busy) return
    setConfirmRevertId(null)
    await revertToCheckpoint(confirmRevertId)
  }, [confirmRevertId, revertToCheckpoint])

  const handleToggleSessionDiff = useCallback(() => {
    const next = !showSessionDiff
    setShowSessionDiff(next)
    if (next) loadSessionDiff()
  }, [showSessionDiff, loadSessionDiff])

  if (checkpoints.length === 0) return null

  const reversedCheckpoints = [...checkpoints].reverse()

  return (
    <Box
      borderTop={`1px solid ${tokens.colors.border.glass}`}
      bg="rgba(255, 255, 255, 0.02)"
    >
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py="6px"
        cursor="pointer"
        transition={`background ${tokens.transition.fast}`}
        _hover={{ bg: tokens.colors.bg.hoverSubtle }}
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        aria-expanded={isExpanded}
        aria-label="Toggle checkpoints panel"
      >
        <Flex align="center" gap={2}>
          {isExpanded ? (
            <FiChevronDown size={12} color={tokens.colors.text.muted} />
          ) : (
            <FiChevronRight size={12} color={tokens.colors.text.muted} />
          )}
          <FiClock size={12} color={tokens.colors.text.muted} />
          <Text fontSize="11px" color={tokens.colors.text.muted} fontWeight="500">
            Checkpoints ({checkpoints.length})
          </Text>
        </Flex>

        <Flex align="center" gap={1}>
          {/* Session Diff button */}
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="4px"
            px="8px"
            py="3px"
            borderRadius={tokens.radius.md}
            fontSize="10px"
            fontWeight="500"
            color={!disabled ? tokens.colors.accent.purple : tokens.colors.text.disabled}
            bg="transparent"
            cursor={!disabled ? 'pointer' : 'not-allowed'}
            transition={`all ${tokens.transition.fast}`}
            _hover={!disabled ? { bg: 'rgba(163, 113, 247, 0.1)' } : undefined}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation()
              handleToggleSessionDiff()
            }}
            aria-label="View session diff"
          >
            <FiGitCommit size={10} />
            Diff
          </Box>

          {/* Undo button */}
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="4px"
            px="8px"
            py="3px"
            borderRadius={tokens.radius.md}
            fontSize="10px"
            fontWeight="500"
            color={!disabled && checkpoints.length > 0
              ? tokens.colors.accent.primary
              : tokens.colors.text.disabled}
            bg="transparent"
            cursor={!disabled && checkpoints.length > 0 ? 'pointer' : 'not-allowed'}
            transition={`all ${tokens.transition.fast}`}
            _hover={!disabled && checkpoints.length > 0
              ? { bg: tokens.colors.accent.primarySubtle }
              : undefined}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation()
              handleRevertLast()
            }}
            aria-label="Undo last agent action"
          >
            <FiRotateCcw size={10} />
            Undo
          </Box>
        </Flex>
      </Flex>

      {/* Confirmation dialog (inline) */}
      {confirmRevertId && (
        <Flex
          align="center"
          justify="space-between"
          mx={2}
          mb={1}
          px={3}
          py={2}
          borderRadius={tokens.radius.lg}
          bg={tokens.colors.accent.redSubtle}
          border={`1px solid ${tokens.colors.accent.redMuted}`}
        >
          <Text fontSize="11px" color={tokens.colors.text.primary}>
            Undo {checkpoints.length - checkpoints.findIndex(cp => cp.id === confirmRevertId)} changes?
          </Text>
          <Flex gap={2}>
            <Box
              as="button"
              px="8px"
              py="2px"
              borderRadius={tokens.radius.md}
              fontSize="10px"
              fontWeight="500"
              color={tokens.colors.text.secondary}
              bg="transparent"
              cursor="pointer"
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              onClick={() => setConfirmRevertId(null)}
            >
              Cancel
            </Box>
            <Box
              as="button"
              px="8px"
              py="2px"
              borderRadius={tokens.radius.md}
              fontSize="10px"
              fontWeight="600"
              color={tokens.colors.accent.red}
              bg="transparent"
              cursor="pointer"
              _hover={{ bg: tokens.colors.accent.redSubtle }}
              onClick={handleConfirmRevert}
            >
              Confirm
            </Box>
          </Flex>
        </Flex>
      )}

      {/* Session diff view */}
      {showSessionDiff && (
        <Box mx={2} mb={1}>
          {isLoadingDiff ? (
            <Flex align="center" justify="center" py={3}>
              <Text fontSize="10px" color={tokens.colors.text.muted}>Loading diff...</Text>
            </Flex>
          ) : sessionDiff.length === 0 ? (
            <Flex align="center" justify="center" py={3}>
              <Text fontSize="10px" color={tokens.colors.text.disabled}>No changes in this session</Text>
            </Flex>
          ) : (
            <Box
              maxH="160px"
              overflowY="auto"
              borderRadius={tokens.radius.md}
              bg={tokens.colors.bg.card}
              border={`1px solid ${tokens.colors.border.glass}`}
            >
              {sessionDiff.map((entry) => {
                const fileName = entry.filePath.split('/').pop() || entry.filePath
                const isNew = entry.before === null
                const isDeleted = entry.after === null

                let label: string
                let color: string
                if (isNew) {
                  label = 'created'
                  color = tokens.colors.accent.green
                } else if (isDeleted) {
                  label = 'deleted'
                  color = tokens.colors.accent.red
                } else {
                  label = 'modified'
                  color = tokens.colors.accent.orange
                }

                return (
                  <Flex
                    key={entry.filePath}
                    align="center"
                    gap={2}
                    px={3}
                    py="4px"
                    borderBottom={`1px solid ${tokens.colors.border.glass}`}
                    _last={{ borderBottom: 'none' }}
                  >
                    <Box
                      w="6px"
                      h="6px"
                      borderRadius="full"
                      bg={color}
                      flexShrink={0}
                    />
                    <Text
                      fontSize="11px"
                      color={tokens.colors.text.secondary}
                      flex={1}
                      truncate
                    >
                      {fileName}
                    </Text>
                    <Text
                      fontSize="10px"
                      color={color}
                      fontFamily={tokens.fontFamily.mono}
                      flexShrink={0}
                    >
                      {label}
                    </Text>
                  </Flex>
                )
              })}
            </Box>
          )}
        </Box>
      )}

      {/* Checkpoint list */}
      {isExpanded && (
        <Box
          maxH="200px"
          overflowY="auto"
          px={2}
          pb={2}
        >
          {reversedCheckpoints.map((cp, idx) => {
            const num = checkpoints.length - idx
            const isLast = idx === 0
            const operation = cp.files[0]?.operation || 'write'
            const Icon = operationIcons[operation] || FiFile
            const color = operationColors[operation] || tokens.colors.text.muted

            return (
              <Flex
                key={cp.id}
                align="center"
                justify="space-between"
                px={2}
                py="5px"
                borderRadius={tokens.radius.md}
                transition={`background ${tokens.transition.fast}`}
                _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                gap={2}
              >
                <Flex align="center" gap={2} flex={1} minW={0}>
                  <Text
                    fontSize="10px"
                    color={tokens.colors.text.disabled}
                    fontFamily={tokens.fontFamily.mono}
                    flexShrink={0}
                    w="18px"
                    textAlign="right"
                  >
                    {num}
                  </Text>
                  <Icon size={12} color={color} style={{ flexShrink: 0 }} />
                  <Text
                    fontSize="11px"
                    color={tokens.colors.text.secondary}
                    truncate
                    flex={1}
                  >
                    {cp.description}
                  </Text>
                  <Text
                    fontSize="10px"
                    color={tokens.colors.text.disabled}
                    flexShrink={0}
                    fontFamily={tokens.fontFamily.mono}
                  >
                    {timeAgo(cp.timestamp)}
                  </Text>
                </Flex>

                <Box
                  as="button"
                  display="flex"
                  alignItems="center"
                  px="6px"
                  py="2px"
                  borderRadius={tokens.radius.sm}
                  fontSize="10px"
                  color={!disabled ? tokens.colors.accent.orange : tokens.colors.text.disabled}
                  bg="transparent"
                  cursor={!disabled ? 'pointer' : 'not-allowed'}
                  transition={`all ${tokens.transition.fast}`}
                  _hover={!disabled ? { bg: 'rgba(247, 127, 0, 0.1)' } : undefined}
                  onClick={() => handleRevertClick(cp.id, isLast)}
                  aria-label={`Revert to checkpoint ${num}`}
                  flexShrink={0}
                >
                  <FiRotateCcw size={10} />
                </Box>
              </Flex>
            )
          })}

          {isReverting && (
            <Flex align="center" justify="center" py={2} gap={2}>
              <Box
                w="4px"
                h="4px"
                borderRadius="full"
                bg={tokens.colors.accent.primary}
                animation="statusPulse 1s ease-in-out infinite"
              />
              <Text fontSize="10px" color={tokens.colors.text.muted}>
                Reverting...
              </Text>
            </Flex>
          )}
        </Box>
      )}
    </Box>
  )
}

export default memo(CheckpointPanel)
