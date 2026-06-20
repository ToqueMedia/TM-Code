import { memo, useState, useCallback, useEffect, useMemo } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { useLayoutStore } from '../../stores/layoutStore'
import {
  FiRotateCcw, FiChevronDown, FiClock,
  FiFile, FiFilePlus, FiTrash2, FiEdit3, FiGitCommit, FiAlertTriangle
} from 'react-icons/fi'
import { useCheckpointStore } from '../../stores/checkpointStore'
import { useChatStore } from '../../stores/chatStore'
import { useEditorRepository } from '../../stores/editorStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h`
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
  const revertAll = useCheckpointStore(s => s.revertAll)
  const lastRevertedPaths = useCheckpointStore(s => s.lastRevertedPaths)
  const lastRevertAllResult = useCheckpointStore(s => s.lastRevertAllResult)
  const clearLastRevertedPaths = useCheckpointStore(s => s.clearLastRevertedPaths)
  const sessionDiff = useCheckpointStore(s => s.sessionDiff)
  const isLoadingDiff = useCheckpointStore(s => s.isLoadingDiff)
  const loadSessionDiff = useCheckpointStore(s => s.loadSessionDiff)
  const isStreaming = useChatStore(s => s.isStreaming)
  const isSidebarMode = useLayoutStore(s => s.viewMode) === 'preview'
  const [isExpanded, setIsExpanded] = useState(false)
  const [showSessionDiff, setShowSessionDiff] = useState(false)
  const [confirmRevertId, setConfirmRevertId] = useState<string | null>(null)
  const [showRevertAllConfirm, setShowRevertAllConfirm] = useState(false)
  const [, setTick] = useState(0)

  // Add system message to chat after revert (avoids circular import in store)
  useEffect(() => {
    if (lastRevertedPaths.length === 0) return
    const names = lastRevertedPaths.map(p => p.split('/').pop()).filter(Boolean)
    const result = lastRevertAllResult
    let msg = names.length === 1
      ? `Reverted: ${names[0]}`
      : `Reverted ${names.length} files: ${names.join(', ')}`
    if (result && result.failed.length > 0) {
      const failNames = result.failed.map(f => f.path.split('/').pop()).join(', ')
      msg += ` (${t("checkpoint.revertAllFailed")}: ${failNames})`
    }
    useChatStore.getState().addSystemMessage(msg)
    clearLastRevertedPaths()
  }, [lastRevertedPaths, lastRevertAllResult, clearLastRevertedPaths])

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

  // Check for dirty editor files that would be overwritten by revert.
  const hasDirtyFiles = useMemo(() => {
    const editorState = useEditorRepository.getState()
    const dirtyPaths = new Set<string>(
      editorState.openFiles.filter((f: { isDirty: boolean }) => f.isDirty).map((f: { path: string }) => f.path)
    )
    const checkpointPaths = new Set<string>(
      checkpoints.flatMap(cp => cp.files.flatMap(f =>
        f.newPath ? [f.filePath, f.newPath] : [f.filePath]
      ))
    )
    for (const path of dirtyPaths) {
      if (checkpointPaths.has(path)) return true
    }
    return false
  }, [checkpoints, showRevertAllConfirm])

  const handleRevertLast = useCallback(async () => {
    const { isReverting: busy } = useCheckpointStore.getState()
    if (isStreaming || busy || checkpoints.length === 0) return
    await revertLast()
  }, [isStreaming, checkpoints.length, revertLast])

  const handleRevertAll = useCallback(async () => {
    const { isReverting: busy } = useCheckpointStore.getState()
    if (isStreaming || busy || checkpoints.length === 0) return
    setShowRevertAllConfirm(false)
    try {
      await revertAll()
      setIsExpanded(false)
    } catch {
      useChatStore.getState().addSystemMessage(t("checkpoint.revertAllFailed"))
    }
  }, [isStreaming, checkpoints.length, revertAll])

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
      bg={tokens.colors.bg.card}
      borderRadius={tokens.radius.md}
      overflow="hidden"
    >
      {/* Header — compact strip so it stays out of the way of the workspace. */}
      <Flex
        align="center"
        justify="space-between"
        px={2.5}
        py="3px"
        cursor="pointer"
        transition={`background ${tokens.transition.fast}`}
        _hover={{ bg: tokens.colors.bg.hoverSubtle }}
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        aria-expanded={isExpanded}
        aria-label={t("checkpoint.toggle")}
      >
        <Flex align="center" gap={1.5}>
          <Box
            color={tokens.colors.text.disabled}
            transition={`transform ${tokens.transition.fast}`}
            style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          >
            <FiChevronDown size={11} />
          </Box>
          <FiClock size={10} color={tokens.colors.text.muted} />
          <Text fontSize="10px" color={tokens.colors.text.muted} fontWeight="500" letterSpacing="0.02em">
            {t('checkpoint.count').replace('{count}', String(checkpoints.length))}
          </Text>
        </Flex>

        <Flex align="center" gap={0.5}>
          {/* Session Diff button */}
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="4px"
            px={isSidebarMode ? "5px" : "7px"}
            py="2px"
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
            aria-label={t("checkpoint.viewDiff")}
          >
            <FiGitCommit size={10} />
            {!isSidebarMode && t('checkpoint.viewDiff')}
          </Box>

          {/* Undo button */}
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="4px"
            px={isSidebarMode ? "5px" : "7px"}
            py="2px"
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
            aria-label={t("checkpoint.undoLast")}
          >
            <FiRotateCcw size={10} />
            {!isSidebarMode && t("checkpoint.undoLast")}
          </Box>

          {/* Revert All button */}
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="4px"
            px={isSidebarMode ? "5px" : "7px"}
            py="2px"
            borderRadius={tokens.radius.md}
            fontSize="10px"
            fontWeight="600"
            color={!disabled && checkpoints.length > 0
              ? tokens.colors.accent.red
              : tokens.colors.text.disabled}
            bg="transparent"
            cursor={!disabled && checkpoints.length > 0 ? 'pointer' : 'not-allowed'}
            transition={`all ${tokens.transition.fast}`}
            _hover={!disabled && checkpoints.length > 0
              ? { bg: 'rgba(248, 81, 73, 0.1)' }
              : undefined}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation()
              setShowRevertAllConfirm(true)
            }}
            aria-label={t("checkpoint.revertAll")}
          >
            <FiRotateCcw size={10} />
            {!isSidebarMode && t("checkpoint.revertAll")}
          </Box>
        </Flex>
      </Flex>

      {/* Revert All confirmation dialog */}
      {showRevertAllConfirm && (
        <Flex
          direction="column"
          mx={2}
          mb={2}
          px={3}
          py={2.5}
          borderRadius={tokens.radius.lg}
          bg={tokens.colors.accent.redSubtle}
          border={`1px solid ${tokens.colors.accent.redMuted}`}
        >
          <Text fontSize="11px" color={tokens.colors.text.primary} fontWeight="600">
            {t("checkpoint.revertAllConfirm")}
          </Text>
          <Text fontSize="10px" color={tokens.colors.text.secondary} mt="3px" lineHeight="1.4">
            {t("checkpoint.revertAllDescription").replace('{count}', String(new Set(checkpoints.flatMap(cp => cp.files.map(f => f.filePath))).size))}
          </Text>
          {hasDirtyFiles && (
            <Flex align="center" gap="4px" mt="6px">
              <FiAlertTriangle size={10} color={tokens.colors.accent.orange} />
              <Text fontSize="10px" color={tokens.colors.accent.orange} fontWeight="500">
                {t("checkpoint.revertAllDirtyWarning")}
              </Text>
            </Flex>
          )}
          <Flex gap={2} mt={2.5} justify="flex-end">
            <Box
              as="button"
              px="10px"
              py="3px"
              borderRadius={tokens.radius.md}
              fontSize="10px"
              fontWeight="500"
              color={tokens.colors.text.secondary}
              bg="transparent"
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              onClick={() => setShowRevertAllConfirm(false)}
            >
              {t("checkpoint.cancel")}
            </Box>
            <Box
              as="button"
              px="10px"
              py="3px"
              borderRadius={tokens.radius.md}
              fontSize="10px"
              fontWeight="600"
              color={tokens.colors.accent.red}
              bg="transparent"
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.accent.redSubtle }}
              onClick={handleRevertAll}
            >
              {t("checkpoint.revertAll")}
            </Box>
          </Flex>
        </Flex>
      )}

      {/* Confirmation dialog (inline) */}
      {confirmRevertId && (
        <Flex
          align="center"
          justify="space-between"
          mx={2}
          mb={2}
          px={3}
          py={2.5}
          borderRadius={tokens.radius.lg}
          bg={tokens.colors.accent.redSubtle}
          border={`1px solid ${tokens.colors.accent.redMuted}`}
        >
          <Text fontSize="11px" color={tokens.colors.text.primary}>
            {t('checkpoint.undoN').replace('{count}', String(checkpoints.length - checkpoints.findIndex(cp => cp.id === confirmRevertId)))}
          </Text>
          <Flex gap={2}>
            <Box
              as="button"
              px="10px"
              py="3px"
              borderRadius={tokens.radius.md}
              fontSize="10px"
              fontWeight="500"
              color={tokens.colors.text.secondary}
              bg="transparent"
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              onClick={() => setConfirmRevertId(null)}
            >
              {t("checkpoint.cancel")}
            </Box>
            <Box
              as="button"
              px="10px"
              py="3px"
              borderRadius={tokens.radius.md}
              fontSize="10px"
              fontWeight="600"
              color={tokens.colors.accent.red}
              bg="transparent"
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.accent.redSubtle }}
              onClick={handleConfirmRevert}
            >
              {t("checkpoint.undoLast")}
            </Box>
          </Flex>
        </Flex>
      )}

      {/* Session diff view */}
      {showSessionDiff && (
        <Box mx={2} mb={2}>
          {isLoadingDiff ? (
            <Flex align="center" justify="center" py={3} gap={2}>
              <Box
                w="10px"
                h="10px"
                borderRadius="full"
                border={`2px solid ${tokens.colors.accent.primaryMuted}`}
                borderTopColor={tokens.colors.accent.primary}
                flexShrink={0}
                css={{
                  animation: 'spin 0.7s linear infinite',
                  '@keyframes spin': { to: { transform: 'rotate(360deg)' } },
                }}
              />
              <Text fontSize="10px" color={tokens.colors.text.muted}>{t("checkpoint.loadingDiff")}</Text>
            </Flex>
          ) : sessionDiff.length === 0 ? (
            <Flex align="center" justify="center" py={3}>
              <Text fontSize="10px" color={tokens.colors.text.disabled}>{t("checkpoint.noChanges")}</Text>
            </Flex>
          ) : (
            <Box
              maxH="150px"
              overflowY="auto"
              borderRadius={tokens.radius.lg}
              bg={tokens.colors.bg.overlay}
              border={`1px solid ${tokens.colors.border.glass}`}
              css={{
                '&::-webkit-scrollbar': { width: '4px' },
                '&::-webkit-scrollbar-track': { background: 'transparent' },
                '&::-webkit-scrollbar-thumb': {
                  background: tokens.colors.border.panel,
                  borderRadius: '2px',
                },
              }}
            >
              {sessionDiff.map((entry, idx) => {
                const fileName = entry.filePath.split('/').pop() || entry.filePath
                const isNew = entry.before === null
                const isDeleted = entry.after === null

                let label: string
                let color: string
                let Icon: typeof FiFile
                if (isNew) {
                  label = t('checkpoint.created')
                  color = tokens.colors.accent.green
                  Icon = FiFilePlus
                } else if (isDeleted) {
                  label = t('checkpoint.deleted')
                  color = tokens.colors.accent.red
                  Icon = FiTrash2
                } else {
                  label = t('checkpoint.modified')
                  color = tokens.colors.accent.orange
                  Icon = FiEdit3
                }

                return (
                  <Flex
                    key={entry.filePath}
                    align="center"
                    gap={2}
                    px={3}
                    py="5px"
                    borderBottom={idx < sessionDiff.length - 1 ? `1px solid ${tokens.colors.border.glass}` : 'none'}
                    transition={`background ${tokens.transition.fast}`}
                    _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                  >
                    <Icon size={11} color={color} style={{ flexShrink: 0 }} />
                    <Text
                      fontSize="11px"
                      color={tokens.colors.text.secondary}
                      flex={1}
                      truncate
                    >
                      {fileName}
                    </Text>
                    <Text
                      fontSize="9px"
                      color={color}
                      fontFamily={tokens.fontFamily.mono}
                      fontWeight="600"
                      textTransform="uppercase"
                      letterSpacing="0.05em"
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
          maxH="170px"
          overflowY="auto"
          px={2}
          pb={1.5}
          css={{
            '&::-webkit-scrollbar': { width: '4px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              background: tokens.colors.border.panel,
              borderRadius: '2px',
            },
          }}
        >
          {reversedCheckpoints.map((cp, idx) => {
            const num = checkpoints.length - idx
            const isLast = idx === 0
            const operation = cp.files[0]?.operation || 'write'
            const Icon = operationIcons[operation] || FiFile
            const color = operationColors[operation] || tokens.colors.text.muted
            const fileCount = new Set(cp.files.map(f => f.filePath)).size

            return (
              <Flex
                key={cp.id}
                align="center"
                justify="space-between"
                px={2}
                py="4px"
                borderRadius={tokens.radius.md}
                transition={`background ${tokens.transition.fast}`}
                _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                gap={2}
              >
                <Flex align="center" gap={2} flex={1} minW={0}>
                  <Text
                    fontSize="9px"
                    color={tokens.colors.text.disabled}
                    fontFamily={tokens.fontFamily.mono}
                    fontWeight="600"
                    flexShrink={0}
                    w="18px"
                    textAlign="right"
                  >
                    {num}
                  </Text>
                  <Box
                    w="18px"
                    h="18px"
                    borderRadius={tokens.radius.sm}
                    bg={`${color}15`}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    flexShrink={0}
                  >
                    <Icon size={10} color={color} />
                  </Box>
                  <Text
                    fontSize="11px"
                    color={tokens.colors.text.secondary}
                    truncate
                    flex={1}
                    lineHeight="1.3"
                  >
                    {cp.description}
                  </Text>
                  {fileCount > 1 && (
                    <Text
                      fontSize="9px"
                      color={tokens.colors.text.disabled}
                      fontFamily={tokens.fontFamily.mono}
                      flexShrink={0}
                    >
                      {fileCount}
                    </Text>
                  )}
                  <Text
                    fontSize="9px"
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
                  justifyContent="center"
                  w="22px"
                  h="22px"
                  borderRadius={tokens.radius.sm}
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
            <Flex align="center" justify="center" py={2.5} gap={2}>
              <Box
                w="10px"
                h="10px"
                borderRadius="full"
                border={`2px solid ${tokens.colors.accent.primaryMuted}`}
                borderTopColor={tokens.colors.accent.primary}
                flexShrink={0}
                css={{
                  animation: 'spin 0.7s linear infinite',
                  '@keyframes spin': { to: { transform: 'rotate(360deg)' } },
                }}
              />
              <Text fontSize="10px" color={tokens.colors.text.muted}>
                {t("checkpoint.reverting")}
              </Text>
            </Flex>
          )}
        </Box>
      )}
    </Box>
  )
}

export default memo(CheckpointPanel)
