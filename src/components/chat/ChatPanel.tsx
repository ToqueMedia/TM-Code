import { memo, lazy, Suspense, useEffect, useRef } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiMessageSquare } from 'react-icons/fi'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useChatStore } from '../../stores/chatStore'
import { useMessageWindow } from '../../hooks/useMessageWindow'
import MessageBubble from './MessageBubble'
import ChatSkeleton from './ChatSkeleton'
import AgentStatusBar from './AgentStatusBar'
import PromptBar from '../PromptBar'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

const CheckpointPanel = lazy(() => import('./CheckpointPanel'))

function ChatPanel() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const isLoadingSession = useChatStore(s => s.isLoadingSession)
  // streamingVersion must be subscribed — it's the ONLY selector that triggers
  // re-renders during streaming (messages are mutated in-place for performance).
  useChatStore(s => s.streamingVersion)

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []

  // Pagination — render the last 30 messages initially, expand as the user
  // scrolls back through history. Resets when the active session changes so
  // a fresh conversation starts at the bottom instead of inheriting the
  // previous session's expanded window. Compaction markers
  // (`SystemMessageKind === 'compact_boundary'`) are just ordinary entries
  // in `messages` — they enter the window naturally when the slice reaches
  // them, no special handling needed.
  // pageSize=2 — see ChatView for rationale (tool-heavy turns).
  const { visibleItems, canLoadMore, loadMore, hiddenCount } = useMessageWindow(messages, {
    resetKey: activeSessionId,
    pageSize: 2,
  })

  const { scrollRef, contentRef } = useStickToBottom({
    resize: 'smooth',
    initial: 'instant',
  })

  // Top sentinel — when the user scrolls high enough that this sentinel
  // becomes visible, we pull the next page in. IntersectionObserver is
  // cheaper than a scroll event listener and fires exactly at the
  // threshold instead of on every wheel tick. We capture the scroll
  // container's `scrollHeight` immediately before the React update and
  // restore the relative offset afterwards so the view stays anchored on
  // the same message the user was looking at — without this, every load
  // jumps the viewport upward by the height of the newly inserted
  // messages.
  //
  // Cooldown guard: between firing `loadMore` and the post-paint scroll
  // restore, the sentinel can briefly re-enter the viewport (the new
  // messages prepend ABOVE it, but for one frame the sentinel itself is
  // still inside the rootMargin band). Without the guard, observer fires
  // again and we end up loading two or three pages from a single user
  // intent. The ref is read inside the callback and updated outside React,
  // so it's a sync gate not subject to stale closures.
  const sentinelRef = useRef<HTMLDivElement>(null)
  const isLoadingMoreRef = useRef(false)
  useEffect(() => {
    if (!canLoadMore) return
    const sentinel = sentinelRef.current
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
        // Double rAF — see ChatView for the rationale: one frame for the
        // React commit, a second so `useStickToBottom`'s ResizeObserver
        // handler can run before our manual scrollTop write, otherwise the
        // library either clobbers our position or interprets it as a user
        // scroll and pauses sticking.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const delta = scrollEl.scrollHeight - beforeHeight
            if (delta > 0) scrollEl.scrollTop = beforeTop + delta
            // 200 ms cooldown — long enough for the prepended layout to
            // settle, short enough that a deliberate keep-scrolling-up gesture
            // still feels responsive.
            setTimeout(() => { isLoadingMoreRef.current = false }, 200)
          })
        })
      },
      { root: scrollEl, rootMargin: '120px 0px 0px 0px', threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [canLoadMore, loadMore, scrollRef])

  return (
    <Flex
      direction="column"
      flex="1"
      minW="400px"
      bg={tokens.colors.bg.app}
      borderRight={`1px solid ${tokens.colors.border.default}`}
      height="100%"
    >
      {/* Message List */}
      <Box
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label={t("chat.messages")}
        flex="1"
        overflowY="auto"
        py={3}
      >
        <Box ref={contentRef} minH="100%">
          {isLoadingSession ? (
            <ChatSkeleton />
          ) : messages.length === 0 ? (
            <Flex
              direction="column"
              align="center"
              justify="center"
              minH="100%"
              p={8}
              gap={3}
            >
              <Box
                transform="translateY(0px)"
                transition="transform 0.3s ease"
                _hover={{ transform: 'translateY(-5px)' }}
              >
                <FiMessageSquare
                  size={48}
                  color={tokens.colors.accent.primary}
                  style={{ filter: `drop-shadow(0 0 15px ${tokens.colors.accent.primaryMuted})` }}
                />
              </Box>
              <Text fontSize="lg" color={tokens.colors.text.primary} fontWeight="600">
                TM Code
              </Text>
              <Text fontSize="sm" color={tokens.colors.text.subtle} textAlign="center" maxW="320px">
                Ask me to help with your code. I can create files, explain code, fix bugs, and more.
              </Text>
            </Flex>
          ) : (
            <>
              {canLoadMore && (
                <Box
                  as="button"
                  ref={sentinelRef}
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
            </>
          )}
        </Box>
      </Box>

      {/* Checkpoint Panel */}
      <Suspense fallback={null}>
        <CheckpointPanel />
      </Suspense>

      {/* Agent Status Bar */}
      <AgentStatusBar />

      {/* Prompt bar — full-featured (queue, attachments, slash/mention/hashtag,
          history, BYOK indicator). Same component used by MainLayout and
          PreviewView so behaviour stays consistent across surfaces. */}
      <PromptBar />
    </Flex>
  )
}

export default memo(ChatPanel)
