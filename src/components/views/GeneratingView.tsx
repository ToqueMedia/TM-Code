import { memo, useRef, useEffect, useCallback } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { useChatStore, resolveDiffApprovalByResultId, resolveAllPendingDiffApprovals } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useLayoutStore } from '../../stores/layoutStore'
import MessageBubble from '../chat/MessageBubble'
import DiffPreview from '../chat/DiffPreview'
import DiffService from '../../services/agent/diffService'
import StaticPreviewBuilder from '../../services/agent/staticPreviewBuilder'
import DiffActionsBar from './DiffActionsBar'
import GeneratingStatusBar from './GeneratingStatusBar'
import { tokens } from '@/theme/tokens'

const scrollbarCss = (width: string) => ({
  '&::-webkit-scrollbar': { width },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': { background: tokens.colors.border.panel, borderRadius: '2px' },
})

function GeneratingView() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const pendingDiffs = useChatStore(s => s.pendingDiffs)
  const status = useAgentStore(s => s.status)
  const isStreaming = useChatStore(s => s.isStreaming)
  const totalTokensUsed = useChatStore(s => s.totalTokensUsed)
  const agentStartTime = useChatStore(s => s.agentStartTime)
  const currentTurnCount = useChatStore(s => s.currentTurnCount)

  const chatScrollRef = useRef<HTMLDivElement>(null)
  const diffScrollRef = useRef<HTMLDivElement>(null)
  const acceptedPathsRef = useRef<string[]>([])

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []
  const activeDiffs = pendingDiffs.filter(d => d.status === 'pending')

  useEffect(() => {
    const el = chatScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, messages.length, messages[messages.length - 1]?.content])

  useEffect(() => {
    const el = diffScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeDiffs.length])

  const tryStaticPreview = useCallback(async (paths: string[]) => {
    const builder = StaticPreviewBuilder.getInstance()
    const htmlFile = builder.findHtmlFile(paths)
    if (htmlFile) {
      try { const html = await builder.buildPreview(htmlFile); useLayoutStore.getState().setStaticPreview(html, htmlFile) }
      catch { useLayoutStore.getState().setViewMode('chat') }
    }
  }, [])

  const checkAllDiffsResolved = useCallback(() => {
    setTimeout(async () => {
      const remaining = useChatStore.getState().pendingDiffs.filter(d => d.status === 'pending')
      if (remaining.length === 0 && !useChatStore.getState().isStreaming) {
        const ls = useLayoutStore.getState()
        if (ls.viewMode === 'generating') {
          if (ls.isPreviewServerRunning) ls.setViewMode('preview')
          else if (acceptedPathsRef.current.length > 0) { await tryStaticPreview(acceptedPathsRef.current); acceptedPathsRef.current = [] }
          else ls.setViewMode('chat')
        }
      }
    }, 50)
  }, [tryStaticPreview])

  const handleAcceptDiff = useCallback(async (diffId: string) => {
    const chatStore = useChatStore.getState()
    const diff = chatStore.pendingDiffs.find(d => d.id === diffId)
    if (diff) acceptedPathsRef.current.push(diff.filePath)
    await DiffService.getInstance().acceptDiff(diffId)
    chatStore.removePendingDiff(diffId)
    // Sync inline diff status in chat messages
    chatStore.syncDiffStatusByResultId(diffId, 'approved')
    // Unblock the agent if it's waiting for this diff approval
    resolveDiffApprovalByResultId(diffId, true)
    checkAllDiffsResolved()
  }, [checkAllDiffsResolved])

  const handleRejectDiff = useCallback((diffId: string) => {
    const chatStore = useChatStore.getState()
    DiffService.getInstance().rejectDiff(diffId)
    chatStore.removePendingDiff(diffId)
    // Sync inline diff status in chat messages
    chatStore.syncDiffStatusByResultId(diffId, 'denied')
    // Unblock the agent if it's waiting for this diff approval
    resolveDiffApprovalByResultId(diffId, false)
    checkAllDiffsResolved()
  }, [checkAllDiffsResolved])

  const handleAcceptAll = useCallback(async () => {
    const chatStore = useChatStore.getState()
    acceptedPathsRef.current = chatStore.pendingDiffs
      .filter(d => d.status === 'pending')
      .map(d => d.filePath)
    await chatStore.approveAllPendingDiffs()
    checkAllDiffsResolved()
  }, [checkAllDiffsResolved])

  const handleRejectAll = useCallback(() => {
    const chatStore = useChatStore.getState()
    const pending = chatStore.pendingDiffs.filter(d => d.status === 'pending')
    DiffService.getInstance().rejectAllDiffs()
    // Sync all inline diff statuses
    for (const diff of pending) {
      chatStore.syncDiffStatusByResultId(diff.id, 'denied')
    }
    // Unblock the agent — reject all pending approvals
    resolveAllPendingDiffApprovals(false)
    chatStore.clearPendingDiffs()
    acceptedPathsRef.current = []
    checkAllDiffsResolved()
  }, [checkAllDiffsResolved])

  const totalTokens = totalTokensUsed.input + totalTokensUsed.output

  return (
    <Flex flex="1" overflow="hidden">
      {/* Left: Chat panel */}
      <Flex direction="column" w="35%" minW="300px"
        borderRight={`1px solid ${tokens.colors.border.sidebarPanel}`} overflow="hidden">
        <Box ref={chatScrollRef} flex="1" overflowY="auto" py={3} px={3} css={scrollbarCss('4px')}>
          {messages.map(msg => (
            <MessageBubble key={msg.id} message={msg} isStreaming={msg.id === streamingMessageId} />
          ))}
        </Box>
        <GeneratingStatusBar status={status} isStreaming={isStreaming}
          totalTokens={totalTokens} currentTurnCount={currentTurnCount} agentStartTime={agentStartTime} />
      </Flex>

      {/* Right: Diff panel */}
      <Flex direction="column" flex="1" overflow="hidden" bg={tokens.colors.bg.mainLayout}>
        <DiffActionsBar activeDiffsCount={activeDiffs.length}
          onRejectAll={handleRejectAll} onAcceptAll={handleAcceptAll} />
        <Box ref={diffScrollRef} flex="1" overflowY="auto" p={4} css={scrollbarCss('6px')}>
          {activeDiffs.length === 0 ? (
            <Flex direction="column" align="center" justify="center" height="100%" color={tokens.colors.text.disabled}>
              <Text fontSize={tokens.fontSize.lg}>
                {isStreaming ? 'Waiting for file changes...' : 'No pending changes'}
              </Text>
            </Flex>
          ) : (
            activeDiffs.map(diff => (
              <DiffPreview key={diff.id} diff={diff} onAccept={handleAcceptDiff} onReject={handleRejectDiff} />
            ))
          )}
        </Box>
      </Flex>
    </Flex>
  )
}

export default memo(GeneratingView)
