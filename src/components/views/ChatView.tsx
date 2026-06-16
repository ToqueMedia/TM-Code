import { memo, lazy, Suspense, useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react'
import { Flex, Box, HStack, Text, VStack } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { FiSidebar, FiZap, FiShield, FiChevronDown, FiCheck, FiAlertCircle, FiDatabase, FiEye } from 'react-icons/fi'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useChatStore } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useMcpStore } from '../../stores/mcpStore'
import { activatePreview } from '../../services/previewActivation'
import { useSettingsStore } from '../../stores/settingsStore'
import { useBillingStore, extraConsumptionPct } from '../../stores/billingStore'
import { useAgentStore } from '../../stores/agentStore'
import { useByokState } from '../../hooks/useByokState'
import { useThinkingToggle } from '../../hooks/useThinkingToggle'
import MessageBubble from '../chat/MessageBubble'
import { useMessageWindow } from '../../hooks/useMessageWindow'
import AgentActivityIndicator from '../chat/AgentActivityIndicator'
import ContextWindowIndicator from '../chat/ContextWindowIndicator'
import PostCompactSurvey from '../chat/PostCompactSurvey'
import ChatSkeleton from '../chat/ChatSkeleton'
import ModelIndicator from '../chat/ModelIndicator'
import TmSpeedIndicator from '../chat/TmSpeedIndicator'
import SessionDropdown from './SessionDropdown'
import ChatSuggestions from './ChatSuggestions'
import { GoalCelebration } from '../celebration/GoalCelebration'
const CheckpointPanel = lazy(() => import('../chat/CheckpointPanel'))
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

function ChatView() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const postCompactSurveyPending = useChatStore(s => s.postCompactSurveyPending)
  const isStreaming = useChatStore(s => s.isStreaming)
  const isLoadingSession = useChatStore(s => s.isLoadingSession)
  const currentProject = useProjectStore(s => s.currentProject)
  const isProjectsSidebarVisible = useLayoutStore(s => s.isProjectsSidebarVisible)
  const viewMode = useLayoutStore(s => s.viewMode)
  const isPlanViewerOpen = useLayoutStore(s => s.isPlanViewerOpen)
  const isSidebarMode = viewMode === 'preview' || isPlanViewerOpen
  const mcpServers = useMcpStore(s => s.servers)
  const mcpIsInitializing = useMcpStore(s => s.isInitializing)
  const sandboxEnabled = useSettingsStore(s => s.sandboxEnabled)
  const chatTextFontSize = useSettingsStore(s => s.chatTextFontSize)
  const scaffoldPhase = useLayoutStore(s => s.scaffoldPhase)
  const scaffoldMessage = useLayoutStore(s => s.scaffoldMessage)
  const billingPlan = useBillingStore(s => s.plan)
  const noCredits = useBillingStore(s => s.noCredits)
  const consumedPct = useBillingStore(s => s.consumedPct)
  const tokensConsumed = useBillingStore(s => s.tokensConsumed)
  const tokenBudget = useBillingStore(s => s.tokenBudget)
  const cycleEnd = useBillingStore(s => s.cycleEnd)
  const billingStatus = useBillingStore(s => s.status)
  const tmsRemaining = useBillingStore(s => s.tmsRemaining)
  // Thinking is no longer user-toggleable (claude-vaz parity). The
  // mandatory badge below renders when the backend reports the active
  // model is mandatory-thinking; otherwise nothing surfaces here and
  // reasoning is decided by the request type (forced ON by slash
  // commands /plan, /debug, /review, /te2e; OFF otherwise).
  const { mandatory: thinkingMandatory } = useThinkingToggle()
  const { byokInPlay: showModelIndicator } = useByokState()
  // Last terminal error from the agent loop. The ServiceError thrown for 402
  // (NO_CREDITS), 429 (BUDGET_EXHAUSTED / RATE_LIMIT), 5xx, AUTH_EXPIRED, etc.
  // lands here via onError. Status pins to 'error' until the next turn flips
  // it back to 'awaiting_response', so we tie banner visibility to status —
  // the error string lingers in the store but only renders while we're in
  // the error state.
  const agentStatus = useAgentStore(s => s.status)
  const agentError = useAgentStore(s => s.error)
  // streamingVersion must be subscribed — it's the ONLY selector that triggers
  // re-renders during streaming (messages are mutated in-place for performance).
  const streamingVersion = useChatStore(s => s.streamingVersion)
  // conversationVersion bumps on compaction. Without subscribing here, the
  // useMemo for lastBoundaryIndex sees the same `rawMessages` reference
  // (appendTextDelta mutates in-place) and returns a cached stale value.
  const conversationVersion = useChatStore(s => s.conversationVersion)

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const rawMessages = session?.messages || []
  // claude-vaz parity: when the agent compresses the conversation, hide
  // every message above the most recent compact_boundary marker. The pre-
  // compression history stays in storage (so session export and re-open
  // still see it) but the transcript shows only the boundary marker plus
  // anything that came after. Tracks the LAST boundary (not the first) so
  // repeated compressions over a long-lived session keep collapsing.
  //
  // `revealPreBoundary` overrides this filter when the user explicitly
  // clicks the "Show earlier history" affordance — without it, the
  // pagination ceiling at the boundary is invisible (the load-more sentinel
  // disappears at the boundary and the user has no UI to access history
  // that's still on disk). Resets on session switch so a new conversation
  // doesn't inherit the prior session's "show all" choice.
  const [revealPreBoundary, setRevealPreBoundary] = useState(false)
  useEffect(() => {
    setRevealPreBoundary(false)
  }, [activeSessionId])
  const lastBoundaryIndex = useMemo(() => {
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      if (rawMessages[i].role === 'system' && rawMessages[i].kind === 'compact_boundary') {
        return i
      }
    }
    return -1
  // conversationVersion forces recalculation after compaction even when
  // rawMessages is the same array reference (appendTextDelta mutates in-place).
  }, [rawMessages, conversationVersion])
  const messages = (lastBoundaryIndex === -1 || revealPreBoundary)
    ? rawMessages
    : rawMessages.slice(lastBoundaryIndex)
  const preBoundaryCount = lastBoundaryIndex === -1 ? 0 : lastBoundaryIndex
  const hasHiddenPreBoundary = preBoundaryCount > 0 && !revealPreBoundary
  const projectPath = currentProject?.path || ''

// use-stick-to-bottom: ResizeObserver-based auto-scroll that handles
  // streaming content, expanding diffs, and dynamic height changes.
  //
  // `resize: 'instant'` is deliberate. 'smooth' animates a SPRING scroll every
  // time the content grows while pinned — which on SEND is very visible and
  // wrong: the user's message lands, then the assistant placeholder + the
  // sticky AgentActivityIndicator mount, and the viewport visibly slides down
  // to chase them. Instant keeps the bottom pinned imperceptibly: new content
  // just appears, the view never animates. (If a streaming "tremble" ever
  // resurfaces it must be fixed at the source — redundant/competing scrollers —
  // not by turning every pin into a visible animation.)
  const { scrollRef, contentRef, scrollToBottom, isAtBottom } = useStickToBottom({
    resize: 'instant',
    initial: 'instant',
  })

  // Pagination over the post-compaction-boundary slice — render the most
  // recent 30 messages, expand the window when the user scrolls toward the
  // top. Reset key is the session id so opening another conversation starts
  // at the bottom instead of inheriting an expanded window.
  // pageSize=2: a single assistant turn can render 50+ blocks (tool calls,
  // reasoning, text). 2 turns ≈ a comfortable screenful for tool-heavy
  // sessions; the user explicitly asked for this size after observing that
  // larger pages buried the load-more affordance under too much content.
  const { visibleItems, canLoadMore, loadMore, hiddenCount } = useMessageWindow(messages, {
    resetKey: activeSessionId,
    pageSize: 2,
  })

  // Top sentinel observed via IntersectionObserver. When the sentinel
  // enters the viewport we pull the next page in, then offset the scroll
  // container's scrollTop by the height delta so the user stays anchored
  // on the same message instead of being pushed up. The `isLoadingMoreRef`
  // guard prevents cascading loads — between fire and the post-paint
  // scroll-restore the sentinel can briefly remain inside the rootMargin
  // band and trigger again, pulling two or three pages from one gesture.
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null)
  const isLoadingMoreRef = useRef(false)
  useEffect(() => {
    if (!canLoadMore) return
    const sentinel = loadMoreSentinelRef.current
    const scrollEl = scrollRef.current
    if (!sentinel || !scrollEl) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        if (isLoadingMoreRef.current) return
        isLoadingMoreRef.current = true
        const beforeHeight = scrollEl.scrollHeight
        const beforeTop = scrollEl.scrollTop
        loadMore()
        // Double rAF — wait one frame for React to commit, a second for the
        // browser to paint AND for `useStickToBottom`'s ResizeObserver
        // callback to land. Without the second frame, our manual scrollTop
        // can race with the library's own scroll-tracking writes and either
        // get clobbered (preview jumps to bottom) or trick the library into
        // thinking the user just scrolled (sticky pause). Two frames is
        // enough buffer empirically.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const delta = scrollEl.scrollHeight - beforeHeight
            if (delta > 0) scrollEl.scrollTop = beforeTop + delta
            setTimeout(() => { isLoadingMoreRef.current = false }, 200)
          })
        })
      },
      { root: scrollEl, rootMargin: '120px 0px 0px 0px', threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [canLoadMore, loadMore, scrollRef])

  // Track whether user was at bottom before streaming started.
  // Once the user scrolls away, we stop forcing scroll until they return.
  const wasAtBottomRef = useRef(true)
  const prevStreamingRef = useRef(false)

  useEffect(() => {
    if (isAtBottom) wasAtBottomRef.current = true
  }, [isAtBottom])

  // When the user expands/collapses an inline element (reasoning block,
  // tool call, diff), the message height changes and the stick-to-bottom
  // ResizeObserver fires `scrollToBottom`. If the user clicked an element
  // ABOVE the current viewport, that yanks them away from what they were
  // reading. We listen for an explicit interaction event from those
  // expand/collapse handlers and freeze stick-to-bottom for a tick so the
  // upcoming resize doesn't auto-scroll.
  // Use a ref for isAtBottom to avoid re-registering the listener on every toggle.
  const isAtBottomRef = useRef(isAtBottom)
  isAtBottomRef.current = isAtBottom
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onInteraction = () => {
      if (!isAtBottomRef.current) {
        wasAtBottomRef.current = false
      }
    }
    window.addEventListener('chat-toggle-interaction', onInteraction)
    return () => window.removeEventListener('chat-toggle-interaction', onInteraction)
  }, [])

  // Synchronously scroll to bottom when a new message is added and the user was already at the bottom.
  // This prevents the scroll-jump effect when the user sends a message.
  useLayoutEffect(() => {
    if (wasAtBottomRef.current) {
      scrollToBottom('instant')
    }
  }, [messages.length, scrollToBottom])

  // Re-assert the bottom target during streaming — compensates for
  // ResizeObserver race conditions caused by the 50ms buffer flush + in-place
  // mutations. 'instant' matches the hook's resize mode: a single imperceptible
  // pin, never an animated scroll (see the resize comment above).
  useEffect(() => {
    if (isStreaming && wasAtBottomRef.current) {
      scrollToBottom('instant')
    }
  }, [streamingVersion, isStreaming, scrollToBottom])

  // When streaming ends, the AgentActivityIndicator unmounts (height change)
  // and the hook's "escaped from lock" may be stale. Force a final scroll.
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      if (wasAtBottomRef.current) {
        // Delay to let DOM settle after finalization + indicator unmount
        const timer = setTimeout(() => scrollToBottom('instant'), 80)
        return () => clearTimeout(timer)
      }
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming, scrollToBottom])

  // When user scrolls away during streaming, record it
  const handleScroll = useCallback(() => {
    if (!isAtBottom && isStreaming) {
      wasAtBottomRef.current = false
    }
  }, [isAtBottom, isStreaming])

  const chatTextScaleStyles = useMemo(() => {
    const bodySize = `${chatTextFontSize}px`
    const codeSize = `${Math.max(12, chatTextFontSize - 1)}px`
    return {
      '--chat-a11y-text-size': bodySize,
      '--chat-a11y-code-size': codeSize,
      '& [data-chat-transcript]': {
        fontSize: 'var(--chat-a11y-text-size)',
      },
      '& [data-chat-transcript] :is(p, li, span, div, button, table, th, td)': {
        fontSize: 'var(--chat-a11y-text-size) !important',
        lineHeight: '1.7',
      },
      '& [data-chat-transcript] :is(code, pre, pre *)': {
        fontSize: 'var(--chat-a11y-code-size) !important',
        lineHeight: '1.65',
      },
      '& [data-chat-transcript] :is(h1)': {
        fontSize: `${chatTextFontSize + 6}px !important`,
        lineHeight: '1.35',
      },
      '& [data-chat-transcript] :is(h2)': {
        fontSize: `${chatTextFontSize + 3}px !important`,
        lineHeight: '1.4',
      },
      '& [data-chat-transcript] :is(h3, h4)': {
        fontSize: `${chatTextFontSize + 1}px !important`,
        lineHeight: '1.45',
      },
      '& [data-chat-transcript] :is(p, li, span, div, button, th, td, code, pre)': {
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      },
      '& [data-chat-transcript] :is(button, [role="button"])': {
        whiteSpace: 'normal',
      },
    }
  }, [chatTextFontSize])

  return (
    <Flex
      direction="column"
      flex="1"
      overflow="hidden"
      position="relative"
      fontSize={`${chatTextFontSize}px`}
      css={chatTextScaleStyles}
    >
      {/* Goal celebration overlay (World Cup 2026) — absolute, pointer-events
          none; fires when an agent run completes. */}
      <GoalCelebration />

      {/* Session header bar */}
      <Flex
        align="center"
        justify="space-between"
        px={4}
        py={2}
        borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
        flexShrink={0}
        position="relative"
      >
        <Flex align="center" gap={2} minW={0}>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="28px"
            h="28px"
            borderRadius="6px"
            color={isProjectsSidebarVisible ? tokens.colors.accent.primary : tokens.colors.text.secondary}
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
            onClick={() => useLayoutStore.getState().toggleProjectsSidebar()}
            aria-label={t("view.toggleProjects")}
          >
            <FiSidebar size={15} />
          </Box>
          <Box flex={1} minW={0}>
            <SessionDropdown
              projectPath={projectPath}
              activeSessionId={activeSessionId}
              isStreaming={isStreaming}
            />
          </Box>
          {!isSidebarMode && (
            <Box
              as="button"
              display="flex"
              alignItems="center"
              gap="5px"
              px="8px"
              h="28px"
              borderRadius="6px"
              color={tokens.colors.text.secondary}
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
              onClick={() => useLayoutStore.getState().setViewMode('data')}
              aria-label={t('view.dataManager')}
            >
              <FiDatabase size={13} />
              <Text fontSize="11px" fontWeight="500">{t('view.dataManager')}</Text>
            </Box>
          )}
        </Flex>

        {/* Credits + Isolation + MCP indicators — hidden in sidebar mode
            because 380px can't fit them all. */}
        {!isSidebarMode && (
          <HStack gap={1.5}>
            <ContextWindowIndicator />
            {thinkingMandatory && (
              <Flex
                align="center"
                gap="4px"
                px="6px"
                py="3px"
                borderRadius="5px"
                bg="rgba(163, 113, 247, 0.1)"
                border="1px solid rgba(163, 113, 247, 0.25)"
                color={tokens.colors.accent.purple}
                title={t('chat.thinkingAlwaysOn')}
              >
                <Text fontSize="10px" fontWeight="600" letterSpacing="0.02em">
                  ⚡ Thinking
                </Text>
              </Flex>
            )}
            <TmSpeedIndicator />
            <ModelIndicator />
            {!showModelIndicator && (
              <CreditIndicator
                plan={billingPlan}
                noCredits={noCredits}
                isStreaming={isStreaming}
                consumedPct={consumedPct}
                tokensConsumed={tokensConsumed}
                tokenBudget={tokenBudget}
                cycleEnd={cycleEnd}
                status={billingStatus}
                tmsRemaining={tmsRemaining}
              />
            )}
            {sandboxEnabled && (
              <IsolationPill
                icon={FiShield}
                label={t('chat.sandboxMode')}
                color={tokens.colors.accent.orange}
                onClick={() => useLayoutStore.getState().setViewMode('settings')}
              />
            )}
            <McpIndicator
              servers={mcpServers}
              isInitializing={mcpIsInitializing}
            />
            <Box
              as="button"
              display="flex"
              alignItems="center"
              gap="5px"
              px="8px"
              h="28px"
              borderRadius="6px"
              color={tokens.colors.text.secondary}
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
              onClick={() => void activatePreview(projectPath)}
              aria-label={t('view.preview')}
            >
              <FiEye size={13} />
              <Text fontSize="11px" fontWeight="500">{t('view.preview')}</Text>
            </Box>
          </HStack>
        )}
      </Flex>

      {/* Scaffold pipeline status banner */}
      <AnimatePresence>
        {scaffoldPhase && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            style={{ flexShrink: 0, overflow: 'hidden' }}
          >
            <Flex
              align="center"
              gap={2}
              px={4}
              py={2}
              bg={
                scaffoldPhase === 'error' ? tokens.colors.accent.redSubtle
                : scaffoldPhase === 'ready' ? tokens.colors.accent.greenSubtle
                : tokens.colors.accent.primarySubtle
              }
              borderBottom={`1px solid ${
                scaffoldPhase === 'error' ? tokens.colors.accent.redMuted
                : scaffoldPhase === 'ready' ? tokens.colors.accent.greenMuted
                : tokens.colors.accent.primaryMuted
              }`}
            >
              {(scaffoldPhase === 'installing' || scaffoldPhase === 'starting') && (
                <Box
                  w="14px"
                  h="14px"
                  borderRadius="full"
                  border={`2px solid ${tokens.colors.accent.primaryMuted}`}
                  borderTopColor={tokens.colors.accent.primary}
                  flexShrink={0}
                  css={SPIN_KEYFRAMES}
                />
              )}
              {scaffoldPhase === 'ready' && (
                <Box color={tokens.colors.accent.green} flexShrink={0}>
                  <FiCheck size={14} />
                </Box>
              )}
              {scaffoldPhase === 'error' && (
                <Box color={tokens.colors.accent.red} flexShrink={0}>
                  <FiAlertCircle size={14} />
                </Box>
              )}
              <Text
                fontSize={tokens.fontSize.xs}
                color={
                  scaffoldPhase === 'error' ? tokens.colors.accent.red
                  : scaffoldPhase === 'ready' ? tokens.colors.accent.green
                  : tokens.colors.text.secondary
                }
                fontWeight={500}
              >
                {scaffoldMessage}
              </Text>
            </Flex>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Agent error banner — surfaces 402/429/5xx/AUTH_EXPIRED messages
          from the agent loop. CMD mode shows this in TerminalStatusLine's
          error label; chat had nothing equivalent, so a "Sem créditos
          disponíveis" or "Sessão expirada" message would land in
          agentStore.error and never render. Visibility is tied to status
          ('error') so the banner clears automatically when the next turn
          starts (setStatus → 'awaiting_response'). */}
      {agentStatus === 'error' && agentError && (
        <Flex
          align="center"
          gap={2}
          px={4}
          py="6px"
          flexShrink={0}
          bg="rgba(248, 81, 73, 0.08)"
          borderBottom="1px solid rgba(248, 81, 73, 0.25)"
        >
          <Box flexShrink={0} color={tokens.colors.accent.red}>
            <FiAlertCircle size={14} />
          </Box>
          <Text fontSize="12px" color={tokens.colors.accent.red} fontWeight={500} flex={1} lineClamp={2}>
            {agentError}
          </Text>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="20px"
            h="20px"
            borderRadius="4px"
            color={tokens.colors.accent.red}
            opacity={0.7}
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ opacity: 1, bg: 'rgba(248, 81, 73, 0.12)' }}
            onClick={() => {
              useAgentStore.getState().setError(null)
              useAgentStore.getState().setStatus('idle')
            }}
            aria-label={t('chat.dismissError')}
          >
            <Text fontSize="14px" lineHeight="1">×</Text>
          </Box>
        </Flex>
      )}

      {/* Billing overage banner — always visible (loading / empty state / with
          messages) when the cycle budget is exhausted. The previous version
          lived inside the messages-only branch, so an over-budget user that
          opened a fresh session saw nothing. CMD mode already had a
          top-level banner; this brings chat to parity. The text adapts to
          BYOK so the user understands their own key is now serving the
          requests instead of the platform's plan tokens. */}
      {consumedPct > 1 && (
        <Flex
          align="center"
          justify="center"
          gap={2}
          px={4}
          py="6px"
          flexShrink={0}
          bg="rgba(247, 127, 0, 0.08)"
          borderBottom="1px solid rgba(247, 127, 0, 0.2)"
        >
          <Box w="8px" h="8px" borderRadius="full" bg={tokens.colors.accent.orange} flexShrink={0} />
          <Text fontSize="12px" color={tokens.colors.accent.orange} fontWeight="500">
            {showModelIndicator ? t('chat.byokOverBudget') : t('chat.billingSpillover')}{' '}
            {(() => {
              if (showModelIndicator) return null
              const remainingPct = extraConsumptionPct(tmsRemaining, tokenBudget)
              if (remainingPct !== null && remainingPct > 0) {
                return `${remainingPct}% ${t('chat.extraCreditsRemaining')}`
              }
              return t('chat.noCreditsRemaining')
            })()}
          </Text>
          {!showModelIndicator && billingPlan !== 'explorer' && tmsRemaining <= 0 && (
            <Text
              as="a"
              fontSize="12px"
              color={tokens.colors.accent.purple}
              fontWeight="600"
              cursor="pointer"
              _hover={{ textDecoration: 'underline' }}
              onClick={() => {
                try { window.open('https://toquemedia.studio/upgrade', '_blank') } catch {}
              }}
            >
              {t('chat.buyCredits')} →
            </Text>
          )}
        </Flex>
      )}

        <Box position="relative" flex="1" overflow="hidden">
        <Box
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-label={t("chat.messages")}
          h="100%"
          overflowY="auto"
          pl={4}
          pr="22px"
          onScroll={handleScroll}
          css={{
            scrollbarGutter: 'stable',
            '&::-webkit-scrollbar': { width: '6px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              background: tokens.colors.border.panel,
              borderRadius: '3px',
            },
          }}
        >
          <Box ref={contentRef} minH="100%" display="flex" flexDirection="column">
            {isLoadingSession ? (
              <Box maxW="900px" mx="auto" w="100%" py={4}>
                <ChatSkeleton />
              </Box>
            ) : messages.length === 0 ? (
              // Empty state for ANY chat with no messages — not just empty
              // projects. The previous `hasContent === false` gate depended on
              // an async glob_files invoke; when that resolved to null/true (or
              // its callback was dropped on a dev reload) an empty session
              // showed a blank pane instead of the suggestions.
              <ChatSuggestions />
            ) : (
              <Box
                maxW="900px"
                mx="auto"
                w="100%"
                py={4}
                data-selectable="true"
                data-chat-transcript
              >
                {/* Reveal-earlier-history affordance — only visible when:
                    (a) the agent has compressed the conversation at least
                    once (so there ARE pre-boundary messages on disk), AND
                    (b) the current window has already been fully expanded
                    via the load-more sentinel below (otherwise the sentinel
                    is doing its job and the button would be premature).
                    Click flips `revealPreBoundary`, which removes the
                    boundary filter so pagination operates on the full
                    rawMessages array. */}
                {hasHiddenPreBoundary && !canLoadMore && (
                  <Box
                    as="button"
                    w="100%"
                    textAlign="center"
                    fontSize={tokens.fontSize.xs}
                    fontWeight="500"
                    color={tokens.colors.text.muted}
                    py={2}
                    px={4}
                    borderRadius="6px"
                    bg={tokens.colors.bg.hoverSubtle}
                    border={`1px solid ${tokens.colors.border.panel}`}
                    cursor="pointer"
                    transition={`all ${tokens.transition.fast}`}
                    _hover={{
                      color: tokens.colors.text.primary,
                      borderColor: tokens.colors.border.glass,
                    }}
                    onClick={() => setRevealPreBoundary(true)}
                  >
                    Show earlier history ({preBoundaryCount} message{preBoundaryCount === 1 ? '' : 's'} before the last compaction)
                  </Box>
                )}
                {canLoadMore && (
                  <Box
                    as="button"
                    ref={loadMoreSentinelRef}
                    w="100%"
                    textAlign="center"
                    fontSize={tokens.fontSize.xs}
                    fontWeight="500"
                    color={tokens.colors.text.muted}
                    py={2.5}
                    px={4}
                    mb={2}
                    borderRadius="6px"
                    bg={tokens.colors.bg.hoverSubtle}
                    border={`1px solid ${tokens.colors.border.panel}`}
                    cursor="pointer"
                    transition={`all ${tokens.transition.fast}`}
                    _hover={{
                      color: tokens.colors.text.primary,
                      borderColor: tokens.colors.border.glass,
                      bg: tokens.colors.bg.overlay,
                    }}
                    onClick={() => loadMore()}
                  >
                    ↑ Load earlier messages — {hiddenCount} hidden
                  </Box>
                )}
                {visibleItems.map(msg => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    isStreaming={msg.id === streamingMessageId}
                  />
                ))}
                <AgentActivityIndicator />
                {postCompactSurveyPending && !isStreaming && <PostCompactSurvey />}
                <Suspense fallback={null}>
                  <CheckpointPanel />
                </Suspense>
              </Box>
            )}
          </Box>
        </Box>

        {/* Scroll-to-bottom anchor button — shows when user scrolls up */}
        {!isAtBottom && (
          <Box
            as="button"
            position="absolute"
            bottom="8px"
            left="50%"
            transform="translateX(-50%)"
            px={3}
            py="6px"
            borderRadius="full"
            bg={tokens.colors.bg.overlay}
            border="1px solid"
            borderColor={tokens.colors.border.panel}
            color={tokens.colors.text.secondary}
            fontSize="11px"
            fontWeight="600"
            cursor="pointer"
            boxShadow="0 4px 12px rgba(0,0,0,0.3)"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
            onClick={() => scrollToBottom('instant')}
            zIndex={10}
          >
            ↓
          </Box>
        )}
        </Box>

    </Flex>
  )
}

// ─── Credit Indicator (imported from shared component) ─────────────────────
// The full CreditIndicator lives in ui/CreditIndicator.tsx to avoid
// duplication. Re-exported here for backward-compat with ChatView imports.
import { CreditIndicator } from '../ui/CreditIndicator'

// ─── Isolation Pill ──────────────────────────────────────────────────────────

function IsolationPill({ icon: Icon, label, color, onClick }: {
  icon: React.ComponentType<{ size?: number; color?: string }>
  label: string
  color: string
  onClick?: () => void
}) {
  return (
    <HStack
      gap={1}
      px={2}
      py="3px"
      borderRadius="9999px"
      border="1px solid rgba(255, 255, 255, 0.08)"
      cursor="pointer"
      transition="all 0.15s"
      _hover={{ bg: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.12)' }}
      onClick={onClick}
    >
      <Icon size={10} color={color} />
      <Text fontSize="10px" color={color} fontWeight="600" fontFamily={tokens.fontFamily.mono}>
        {label}
      </Text>
    </HStack>
  )
}

// ─── Extracted @keyframes — module-level to avoid Emotion re-injection per render ──

const SPIN_KEYFRAMES = { animation: 'spin 0.8s linear infinite', '@keyframes spin': { to: { transform: 'rotate(360deg)' } } }

// ─── MCP Indicator (collapsed pill with dropdown) ────────────────────────────

interface McpServer {
  name: string
  status: string
  tools: unknown[]
}

function McpIndicator(props: { servers: McpServer[]; isInitializing: boolean }) {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const running = props.servers.filter(s => s.status === 'running')
  const errored = props.servers.filter(s => s.status === 'error')
  const totalTools = running.reduce((sum, s) => sum + s.tools.length, 0)

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  // Nothing to show
  if (!props.isInitializing && running.length === 0 && errored.length === 0) {
    return null
  }

  // Determine pill appearance
  let pillColor: string = tokens.colors.accent.green
  let pillLabel = `MCP ${running.length}`
  if (props.isInitializing) {
    pillColor = tokens.colors.accent.orange
    pillLabel = 'MCP...'
  } else if (errored.length > 0 && running.length === 0) {
    pillColor = tokens.colors.accent.red
    pillLabel = `MCP ${errored.length}`
  } else if (running.length > 0) {
    pillLabel = `MCP ${running.length} (${totalTools})`
  }

  return (
    <Box position="relative" ref={ref}>
      <HStack
        gap={1}
        px={2}
        py="3px"
        borderRadius={tokens.radius.full}
        bg="rgba(255, 255, 255, 0.04)"
        border="1px solid"
        borderColor={isOpen ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)'}
        cursor="pointer"
        transition={`all ${tokens.transition.fast}`}
        _hover={{ bg: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.12)' }}
        onClick={() => setIsOpen(!isOpen)}
      >
        <FiZap size={10} color={pillColor} />
        <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
          {pillLabel}
        </Text>
        <FiChevronDown
          size={9}
          color={tokens.colors.text.disabled}
          style={{
            transition: 'transform 0.15s',
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </HStack>

      {/* Dropdown */}
      {isOpen && (
        <VStack
          position="absolute"
          top="calc(100% + 4px)"
          right={0}
          minW="200px"
          bg={tokens.colors.bg.overlay}
          border="1px solid"
          borderColor={tokens.colors.border.panel}
          borderRadius="8px"
          boxShadow="0 8px 24px rgba(0,0,0,0.4)"
          py={1}
          gap={0}
          zIndex={tokens.zIndex.dropdown}
        >
          {props.isInitializing && (
            <McpDropdownItem name="MCP" detail="A iniciar..." color={tokens.colors.accent.orange} />
          )}
          {running.map(server => (
            <McpDropdownItem
              key={server.name}
              name={server.name}
              detail={`${server.tools.length} tools`}
              color={tokens.colors.accent.green}
            />
          ))}
          {errored.map(server => (
            <McpDropdownItem
              key={server.name}
              name={server.name}
              detail={t("misc.error")}
              color={tokens.colors.accent.red}
            />
          ))}
          {running.length === 0 && errored.length === 0 && !props.isInitializing && (
            <Text fontSize="11px" color={tokens.colors.text.disabled} px={3} py={2}>
              Sem servidores MCP
            </Text>
          )}
        </VStack>
      )}
    </Box>
  )
}

function McpDropdownItem(props: { name: string; detail: string; color: string }) {
  return (
    <Flex
      align="center"
      gap={2}
      px={3}
      py="6px"
      w="100%"
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      _hover={{ bg: 'rgba(255, 255, 255, 0.05)' }}
      onClick={() => useLayoutStore.getState().setViewMode('settings')}
    >
      <Box w="6px" h="6px" borderRadius="full" bg={props.color} flexShrink={0} />
      <Text fontSize="11px" color={tokens.colors.text.primary} fontWeight="500" flex={1}>
        {props.name}
      </Text>
      <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
        {props.detail}
      </Text>
    </Flex>
  )
}

export default memo(ChatView)
