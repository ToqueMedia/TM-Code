import { memo, useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react'
import { Flex, Box, HStack, Text, VStack } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { VscShield, VscCheck, VscWarning, VscEye, VscEllipsis, VscHistory, VscClose, VscChevronDown, VscTerminal } from 'react-icons/vsc'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useChatStore } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { activatePreview } from '../../services/previewActivation'
import { useSettingsStore } from '../../stores/settingsStore'
import { useBillingStore, extraConsumptionPct } from '../../stores/billingStore'
import { useAgentStore } from '../../stores/agentStore'
import { useCollabStore } from '../../stores/collabStore'
import { useCheckpointStore } from '../../stores/checkpointStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { useByokState } from '../../hooks/useByokState'
import MessageBubble from '../chat/MessageBubble'
import { useMessageWindow } from '../../hooks/useMessageWindow'
import AgentActivityIndicator from '../chat/AgentActivityIndicator'
import PostCompactSurvey from '../chat/PostCompactSurvey'
import ChatSkeleton from '../chat/ChatSkeleton'
import ChatWorkingTips from '../chat/ChatWorkingTips'
import ChatSuggestions from './ChatSuggestions'
import { CollabShareControls } from '../collab/CollabShareControls'
// Direct file import (NOT the '../welcome' barrel): the barrel pulls in
// WelcomeSidebar → @tauri-apps/api/menu, which breaks jsdom tests that mount
// ChatView. PromoBanner itself has no Tauri deps.
import PromoBanner from '../welcome/PromoBanner'
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
  const viewMode = useLayoutStore(s => s.viewMode)
  const isPlanViewerOpen = useLayoutStore(s => s.isPlanViewerOpen)
  const isCheckpointDrawerOpen = useLayoutStore(s => s.isCheckpointDrawerOpen)
  const isSidebarMode = viewMode === 'preview' || isPlanViewerOpen || isCheckpointDrawerOpen
  const sandboxEnabled = useSettingsStore(s => s.sandboxEnabled)
  const chatTextFontSize = useSettingsStore(s => s.chatTextFontSize)
  const scaffoldPhase = useLayoutStore(s => s.scaffoldPhase)
  const scaffoldMessage = useLayoutStore(s => s.scaffoldMessage)
  const billingPlan = useBillingStore(s => s.plan)
  // While sharing a team Live Preview, opening the normal preview would start a
  // second dev server (port collision) — disable the Preview button until the
  // share stops.
  const isSharingLivePreview = useCollabStore(s => s.sharingPreview)
  const consumedPct = useBillingStore(s => s.consumedPct)
  const tokenBudget = useBillingStore(s => s.tokenBudget)
  const tmsRemaining = useBillingStore(s => s.tmsRemaining)
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
  const hasProject = Boolean(currentProject?.path)
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
  // wrong: the user's message lands, then the assistant placeholder + activity
  // indicator mount, and the viewport visibly slides down to chase them.
  // Instant keeps the bottom pinned imperceptibly: new content just appears,
  // the view never animates. (If a streaming "tremble" ever resurfaces it must
  // be fixed at the source — redundant/competing scrollers — not by turning
  // every pin into a visible animation.)
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
      // The chat COLUMN is the responsive unit, not the window. Side drawers
      // (team chat 360px, terminal, checkpoints) squeeze this column without
      // changing the viewport, so a viewport @media query left the toolbar's
      // wide-only cluster visible while 360px of room vanished — the
      // flexShrink=0 indicators painted over the session dropdown. The
      // container query below measures THIS element instead. The file-tree
      // sidebar is an overlay (takes no width), so in plain chat mode
      // container width ≈ viewport width and the 1180px threshold keeps its
      // original meaning exactly.
      containerType: 'inline-size',
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
      '& [data-chat-toolbar]': {
        minHeight: '44px',
        maxHeight: '44px',
        overflow: 'visible',
      },
      '& [data-chat-toolbar] :is(button, [role="button"])': {
        whiteSpace: 'nowrap',
      },
      '& [data-chat-toolbar-label]': {
        whiteSpace: 'nowrap',
        lineHeight: '1',
      },
      '& [data-chat-toolbar-overflow-trigger]': {
        display: 'none',
      },
      // Sessions + billing/model indicators moved UP to the MinimalTitleBar, so
      // this toolbar now holds only a few small actions (Sandbox / Live Preview
      // share / Preview). The old 1180px collapse fired way too early for that —
      // it only needs to fold into the "…" menu when the chat column is genuinely
      // tight (side drawer open + narrow window). Collapse only near collision.
      '@container (max-width: 480px)': {
        '& [data-chat-toolbar-wide-only]': {
          display: 'none !important',
        },
        '& [data-chat-toolbar-overflow-trigger]': {
          display: 'flex !important',
        },
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
      {/* Session header bar */}
      {hasProject && (
        <Flex
          data-chat-toolbar
          align="center"
          justify="space-between"
          gap={2}
          px={4}
          py={1.5}
          borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
          bg={tokens.colors.bg.whiteMicro}
          flexShrink={0}
          position="relative"
        >
        <Flex align="center" gap={1.5} minW={0} overflow="visible">
          {/* Sessions + New Chat moved UP to the MinimalTitleBar. */}
          {/* In preview/sidebar mode the right-hand indicator cluster (which
              normally hosts the team controls) is hidden, so the user loses
              the Live Preview + Chat affordances. Surface them here, next to
              the session dropdown, so sharing stays reachable while the
              preview is open. */}
          {/* Em sidebar mode o cluster wide-only (que hospeda os Checkpoints)
              está desmontado — e o drawer de checkpoints É um dos modos que
              liga o isSidebarMode. Sem esta segunda montagem, abrir o drawer
              fazia desaparecer o próprio botão que o fecha. */}
          {isSidebarMode && <CheckpointsToolbarButton />}
          {isSidebarMode && <TerminalToolbarButton />}
          {isSidebarMode && <CollabShareControls compact previewOnly />}
        </Flex>

        {/* Isolation + MCP + team indicators — hidden in sidebar mode because
            380px can't fit them all. Credits are NOT here: the CreditIndicator
            renders after this block, outside both this gate and the wide-only
            cluster, so it survives every responsive compaction. */}
        {!isSidebarMode && (
          <>
            <HStack data-chat-toolbar-wide-only gap={1.5} flexShrink={0} overflow="visible">
              {/* TM Speed / model indicators moved UP to the MinimalTitleBar. */}
              {sandboxEnabled && (
                <IsolationPill
                  icon={VscShield}
                  label={t('chat.sandboxMode')}
                  color={tokens.colors.accent.orange}
                  onClick={() => useLayoutStore.getState().setViewMode('settings')}
                />
              )}
              {/* MCP moved to the prompt actions row (PromptActions). */}
              {/* Checkpoints — mudou da linha de acções do prompt para aqui
                  (07-08), à ESQUERDA do Live Preview e do Preview. */}
              <CheckpointsToolbarButton />
              <TerminalToolbarButton />
              {/* Project-scoped Live Preview share only — chat/presence moved to
                  the persistent WelcomeSidebar team section (previewOnly). */}
              <CollabShareControls previewOnly />
              <Box
                as="button"
                data-chat-toolbar-action
                display="flex"
                alignItems="center"
                gap="5px"
                px="8px"
                h="28px"
                borderRadius="6px"
                color={tokens.colors.text.secondary}
                cursor={isSharingLivePreview ? 'not-allowed' : 'pointer'}
                opacity={isSharingLivePreview ? 0.4 : 1}
                aria-disabled={isSharingLivePreview}
                transition={`all ${tokens.transition.fast}`}
                _hover={isSharingLivePreview ? {} : { bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
                onClick={() => { if (!isSharingLivePreview) void activatePreview(projectPath) }}
                aria-label={t('view.preview')}
                title={isSharingLivePreview ? t('team.previewBlockedBySharing') : t('view.preview')}
              >
                <VscEye size={13} />
                <Text data-chat-toolbar-secondary-label fontSize="11px" fontWeight="500">{t('view.preview')}</Text>
              </Box>
            </HStack>
            <HeaderOverflowMenu />
          </>
        )}

        {/* Credits / model indicators moved UP to the MinimalTitleBar. */}
        </Flex>
      )}

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
                  <VscCheck size={14} />
                </Box>
              )}
              {scaffoldPhase === 'error' && (
                <Box color={tokens.colors.accent.red} flexShrink={0}>
                  <VscWarning size={14} />
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

      {/* Aviso de expiração de plano (≤10 dias) — mesma janela do banner da
          Web (PlanExpiryBanner). Fonte: billing.planExpiresAt do /v1/me
          (subscription.expiresAt; para equipas, a expiração da subscrição da
          equipa). Ausente em workers antigos → sem banner (degrada limpo). */}
      <PlanExpiryNotice />

      {/* Agent error banner — surfaces 402/429/5xx/AUTH_EXPIRED messages
          from the agent loop. The shell-styled status line has its own
          error label; this keeps the main chat equally visible, so a "Sem créditos
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
            <VscWarning size={14} />
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
            _hover={{ opacity: 1, bg: tokens.colors.accent.redSubtle }}
            onClick={() => {
              useAgentStore.getState().setError(null)
              useAgentStore.getState().setStatus('idle')
            }}
            aria-label={t('chat.dismissError')}
          >
            <VscClose size={12} />
          </Box>
        </Flex>
      )}

      {/* Billing overage banner — always visible (loading / empty state / with
          messages) when the cycle budget is exhausted. The previous version
          lived inside the messages-only branch, so an over-budget user that
          opened a fresh session saw nothing. This top-level banner keeps
          the main chat consistent. The text adapts to
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
              <Box maxW="980px" mx="auto" w="100%" py={4}>
                <ChatSkeleton />
              </Box>
            ) : messages.length === 0 ? (
              // Empty state for ANY chat with no messages — not just empty
              // projects. The previous `hasContent === false` gate depended on
              // an async glob_files invoke; when that resolved to null/true (or
              // its callback was dropped on a dev reload) an empty session
              // showed a blank pane instead of the suggestions.
              // PromoBanner rides here: it shows while there's an active promotion
              // and vanishes the moment the chat opens (messages > 0 swaps this
              // whole branch out). Returns null when there's no promo, so it's
              // invisible otherwise.
              <>
                <Box px={4} pt={4} w="100%" flexShrink={0}>
                  <PromoBanner />
                </Box>
                <ChatSuggestions />
              </>
            ) : (
              <Box
                maxW="980px"
                mx="auto"
                w="100%"
                py={5}
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
                    mb={1}
                    cursor="pointer"
                    transition={`color ${tokens.transition.fast}`}
                    _hover={{ color: tokens.colors.text.primary }}
                    onClick={() => setRevealPreBoundary(true)}
                  >
                    {t('chat.showEarlierHistory').replace('{count}', String(preBoundaryCount))}
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
                    py={2}
                    px={4}
                    mb={3}
                    cursor="pointer"
                    transition={`color ${tokens.transition.fast}`}
                    _hover={{ color: tokens.colors.text.primary }}
                    onClick={() => loadMore()}
                  >
                    {t('chat.loadEarlier').replace('{count}', String(hiddenCount))}
                  </Box>
                )}
                {visibleItems.map(msg => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    // msg.isStreaming cobre bolhas de TAREFAS PARALELAS
                    // (Fase 4: mutadas in-place na sessão delas) — sem isto o
                    // memo do MessageBubble bloqueava o re-render e o
                    // streaming da tarefa ficava invisível até ao fim.
                    isStreaming={msg.id === streamingMessageId || msg.isStreaming === true}
                  />
                ))}
                <AgentActivityIndicator />
                {postCompactSurveyPending && !isStreaming && <PostCompactSurvey />}
              </Box>
            )}
          </Box>
        </Box>

        {/* Scroll-to-bottom anchor button — shows when user scrolls up */}
        {!isAtBottom && (
          <Flex
            as="button"
            position="absolute"
            bottom="10px"
            left="50%"
            transform="translateX(-50%)"
            align="center"
            gap={1.5}
            px={3}
            h="28px"
            borderRadius="full"
            bg={tokens.colors.bg.overlay}
            border={`1px solid ${tokens.colors.border.panel}`}
            color={tokens.colors.text.secondary}
            fontSize={tokens.fontSize.xs}
            fontWeight="500"
            cursor="pointer"
            boxShadow={tokens.shadow.toolbar}
            transition={`all ${tokens.transition.fast}`}
            _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
            onClick={() => scrollToBottom('instant')}
            zIndex={10}
            aria-label={t('chat.jumpToLatest')}
          >
            <VscChevronDown size={13} />
            <Text fontSize={tokens.fontSize.xs} fontWeight="500" whiteSpace="nowrap">
              {t('chat.jumpToLatest')}
            </Text>
          </Flex>
        )}
        </Box>

      {/* Rotating command tips — parity with the shell-styled working tips.
          Subtle line above the PromptBar, only while the agent is working;
          surfaces the slash-command catalogue progressively. */}
      <ChatWorkingTips />

    </Flex>
  )
}

/**
 * Checkpoints — mudou da linha de acções do PromptBar para a toolbar do chat
 * (07-08), à esquerda do Live Preview e do Preview.
 *
 * O terminal passou para o fundo da janela — já não disputa a coluna
 * lateral com este drawer, portanto abrir checkpoints NÃO o fecha.
 * O contador de checkpoints só aparece quando há algum.
 */
function CheckpointsToolbarButton() {
  const checkpointCount = useCheckpointStore(s => s.checkpoints.length)
  const isCheckpointDrawerOpen = useLayoutStore(s => s.isCheckpointDrawerOpen)
  const toggleCheckpointDrawer = useLayoutStore(s => s.toggleCheckpointDrawer)

  return (
    <Box
      as="button"
      data-chat-toolbar-action
      display="flex"
      alignItems="center"
      gap="5px"
      px="8px"
      h="28px"
      flexShrink={0}
      borderRadius="6px"
      color={isCheckpointDrawerOpen ? tokens.colors.accent.primary : tokens.colors.text.secondary}
      bg={isCheckpointDrawerOpen ? tokens.colors.accent.primarySubtle : 'transparent'}
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      _hover={{
        bg: isCheckpointDrawerOpen ? tokens.colors.accent.primarySubtle : tokens.colors.bg.hoverSubtle,
        color: tokens.colors.text.primary,
      }}
      onClick={event => {
        event.stopPropagation()
        toggleCheckpointDrawer()
      }}
      aria-label={t('checkpoint.title')}
      title={t('checkpoint.title')}
    >
      <VscHistory size={13} />
      <Text data-chat-toolbar-secondary-label fontSize="11px" fontWeight="500">{t('checkpoint.title')}</Text>
      {checkpointCount > 0 && (
        <Text
          fontSize="9px"
          fontFamily={tokens.fontFamily.mono}
          color={isCheckpointDrawerOpen ? tokens.colors.accent.primary : tokens.colors.text.disabled}
          lineHeight="1"
        >
          {checkpointCount}
        </Text>
      )}
    </Box>
  )
}

function TerminalToolbarButton() {
  const isOpen = useTerminalPanelStore(s => s.isOpen)
  const toggle = useTerminalPanelStore(s => s.toggle)

  return (
    <Box
      as="button"
      data-chat-toolbar-action
      display="flex"
      alignItems="center"
      gap="5px"
      px="8px"
      h="28px"
      flexShrink={0}
      borderRadius="6px"
      color={isOpen ? tokens.colors.accent.primary : tokens.colors.text.secondary}
      bg={isOpen ? tokens.colors.accent.primarySubtle : 'transparent'}
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      _hover={{
        bg: isOpen ? tokens.colors.accent.primarySubtle : tokens.colors.bg.hoverSubtle,
        color: tokens.colors.text.primary,
      }}
      onClick={event => {
        event.stopPropagation()
        toggle()
      }}
      aria-label={t('prompt.toggleTerminal')}
      title={t('prompt.toggleTerminal')}
    >
      <VscTerminal size={13} />
      <Text data-chat-toolbar-secondary-label fontSize="11px" fontWeight="500">{t('activity.terminal')}</Text>
    </Box>
  )
}

function HeaderOverflowMenu() {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const currentProject = useProjectStore(s => s.currentProject)
  const projectPath = currentProject?.path || ''
  const isSharingLivePreview = useCollabStore(s => s.sharingPreview)
  const sandboxEnabled = useSettingsStore(s => s.sandboxEnabled)
  const checkpointCount = useCheckpointStore(s => s.checkpoints.length)

  useEffect(() => {
    if (!isOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [isOpen])

  const runAndClose = useCallback((callback: () => void) => {
    setIsOpen(false)
    callback()
  }, [])

  return (
    <Box
      data-chat-toolbar-overflow-trigger
      ref={menuRef}
      position="relative"
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
    >
      <Box
        as="button"
        display="flex"
        alignItems="center"
        justifyContent="center"
        w="30px"
        h="30px"
        borderRadius="8px"
        color={isOpen ? tokens.colors.accent.primary : tokens.colors.text.secondary}
        cursor="pointer"
        transition={`all ${tokens.transition.fast}`}
        _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
        onClick={() => setIsOpen(open => !open)}
        aria-label={t('view.moreActions')}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <VscEllipsis size={16} />
      </Box>

      {isOpen && (
        <VStack
          role="menu"
          position="absolute"
          top="calc(100% + 8px)"
          right={0}
          zIndex={tokens.zIndex.dropdown}
          w="280px"
          gap={1}
          align="stretch"
          p={1.5}
          bg={tokens.colors.bg.overlay}
          border={`1px solid ${tokens.colors.border.panel}`}
          borderRadius="10px"
          boxShadow="0 14px 40px rgba(0,0,0,0.45)"
        >
          {/* Checkpoints TEM de estar aqui, não só no cluster wide-only: a
              @container (max-width: 480px) esconde esse cluster e é este menu
              que o substitui. Sem esta entrada, mover o botão do PromptBar
              para a toolbar tornava os Checkpoints INACESSÍVEIS com a coluna
              de chat estreita — no PromptBar ele só perdia a etiqueta. */}
          <ToolbarMenuItem
            icon={<VscHistory size={14} />}
            label={checkpointCount > 0 ? `${t('checkpoint.title')} (${checkpointCount})` : t('checkpoint.title')}
            onClick={() => runAndClose(() => {
              useLayoutStore.getState().toggleCheckpointDrawer()
            })}
          />
          <ToolbarMenuItem
            icon={<VscTerminal size={14} />}
            label={t('activity.terminal')}
            onClick={() => runAndClose(() => {
              useTerminalPanelStore.getState().toggle()
            })}
          />
          <ToolbarMenuItem
            icon={<VscEye size={14} />}
            label={t('view.preview')}
            disabled={isSharingLivePreview}
            hint={isSharingLivePreview ? t('team.previewBlockedBySharing') : undefined}
            onClick={() => {
              if (!projectPath || isSharingLivePreview) return
              runAndClose(() => { void activatePreview(projectPath) })
            }}
          />
          {sandboxEnabled && (
            <ToolbarMenuItem
              icon={<VscShield size={14} />}
              label={t('chat.sandboxMode')}
              onClick={() => runAndClose(() => useLayoutStore.getState().setViewMode('settings'))}
            />
          )}
          {/* MCP + TEAM rows removed: MCP moved to the prompt actions row
              (PromptActions), team collaboration moved to the WelcomeSidebar.
              This menu is now purely actions (Preview / Sandbox). */}
        </VStack>
      )}
    </Box>
  )
}

function ToolbarMenuItem({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  hint?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Box
      as="button"
      role="menuitem"
      display="flex"
      alignItems="center"
      gap={2}
      w="100%"
      h="34px"
      px={2.5}
      borderRadius="8px"
      color={disabled ? tokens.colors.text.disabled : tokens.colors.text.secondary}
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.55 : 1}
      transition={`all ${tokens.transition.fast}`}
      _hover={disabled ? {} : { bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
      onClick={disabled ? undefined : onClick}
      title={hint}
    >
      <Box display="flex" alignItems="center" justifyContent="center" flexShrink={0}>
        {icon}
      </Box>
      <Text fontSize="12px" fontWeight="500" whiteSpace="nowrap" lineHeight="1">
        {label}
      </Text>
    </Box>
  )
}

// ─── Plan expiry notice ─────────────────────────────────────────────────────
// Aviso "o plano expira em N dias" (pedido 2026-07-14). Janela partilhada com
// o banner da Web — mudar aqui pede mudança em PlanExpiryBanner.tsx (web).
const PLAN_EXPIRY_WARNING_DAYS = 10

function PlanExpiryNotice() {
  const plan = useBillingStore(s => s.plan)
  const planExpiresAt = useBillingStore(s => s.planExpiresAt)
  const [dismissed, setDismissed] = useState(false)

  if (dismissed || plan === 'explorer' || !planExpiresAt) return null
  const expiresMs = Date.parse(planExpiresAt)
  if (!Number.isFinite(expiresMs)) return null
  const msLeft = expiresMs - Date.now()
  if (msLeft <= 0) return null
  const daysLeft = Math.ceil(msLeft / 86_400_000)
  if (daysLeft > PLAN_EXPIRY_WARNING_DAYS) return null

  return (
    <Flex
      align="center"
      gap={2}
      px={4}
      py="6px"
      flexShrink={0}
      bg="rgba(247, 127, 0, 0.08)"
      borderBottom="1px solid rgba(247, 127, 0, 0.25)"
    >
      <Box flexShrink={0} color={tokens.colors.accent.orange}>
        <VscWarning size={14} />
      </Box>
      <Text fontSize="12px" color={tokens.colors.accent.orange} fontWeight={500} flex={1} lineClamp={2}>
        {t('chat.planExpiresSoon').replace('{days}', String(daysLeft))}
      </Text>
      <Box
        as="button"
        px={2}
        py="2px"
        borderRadius="4px"
        fontSize="11px"
        fontWeight="600"
        color={tokens.colors.accent.orange}
        bg="rgba(247, 127, 0, 0.15)"
        cursor="pointer"
        transition={`opacity ${tokens.transition.fast}`}
        _hover={{ opacity: 0.85 }}
        onClick={() => {
          import('@tauri-apps/plugin-opener').then(opener => {
            opener.openUrl('https://code.toquemedia.net/account/billing').catch(() => {})
          })
        }}
      >
        {t('chat.planExpiresRenew')}
      </Box>
      <Box
        as="button"
        display="flex"
        alignItems="center"
        justifyContent="center"
        w="20px"
        h="20px"
        borderRadius="4px"
        color={tokens.colors.accent.orange}
        opacity={0.7}
        cursor="pointer"
        transition={`all ${tokens.transition.fast}`}
        _hover={{ opacity: 1, bg: 'rgba(247, 127, 0, 0.12)' }}
        onClick={() => setDismissed(true)}
        aria-label={t('chat.dismissError')}
      >
        <VscClose size={12} />
      </Box>
    </Flex>
  )
}

// ─── Credit Indicator (imported from shared component) ─────────────────────
// The full CreditIndicator lives in ui/CreditIndicator.tsx to avoid
// duplication. Re-exported here for backward-compat with ChatView imports.

// ─── Isolation Pill ──────────────────────────────────────────────────────────

function IsolationPill({ icon: Icon, label, color, onClick }: {
  icon: React.ComponentType<{ size?: number; color?: string }>
  label: string
  color: string
  onClick?: () => void
}) {
  return (
    <Flex
      as="button"
      align="center"
      gap={1.5}
      px="8px"
      h="28px"
      borderRadius="6px"
      color={color}
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      _hover={{ bg: tokens.colors.bg.hoverSubtle }}
      onClick={onClick}
      aria-label={label}
    >
      <Icon size={12} color={color} />
      <Text fontSize={tokens.fontSize.xs} color={color} fontWeight="500">
        {label}
      </Text>
    </Flex>
  )
}

// ─── Extracted @keyframes — module-level to avoid Emotion re-injection per render ──

const SPIN_KEYFRAMES = { animation: 'spin 0.8s linear infinite', '@keyframes spin': { to: { transform: 'rotate(360deg)' } } }


export default memo(ChatView)
