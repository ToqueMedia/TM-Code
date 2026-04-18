import { memo, useRef, useEffect, useState, useCallback } from 'react'
import { Flex, Box, HStack, Text, VStack } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { FiSidebar, FiZap, FiShield, FiChevronDown, FiCheck, FiAlertCircle, FiClipboard } from 'react-icons/fi'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useChatStore } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useBillingStore, isInOverageState, type UserPlanName, type CostBudgetStatus } from '../../stores/billingStore'
import MessageBubble from '../chat/MessageBubble'
import AgentActivityIndicator from '../chat/AgentActivityIndicator'
import ChatSkeleton from '../chat/ChatSkeleton'
import SessionDropdown from './SessionDropdown'
import ChatSuggestions from './ChatSuggestions'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

function ChatView() {
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const isStreaming = useChatStore(s => s.isStreaming)
  const isLoadingSession = useChatStore(s => s.isLoadingSession)
  const currentProject = useProjectStore(s => s.currentProject)
  const isProjectsSidebarVisible = useLayoutStore(s => s.isProjectsSidebarVisible)
  const mcpServers = useMcpStore(s => s.servers)
  const mcpIsInitializing = useMcpStore(s => s.isInitializing)
  const sandboxEnabled = useSettingsStore(s => s.sandboxEnabled)
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
  const thinkingEnabled = useSettingsStore(s => s.thinkingEnabled)
  const setThinkingEnabled = useSettingsStore(s => s.setThinkingEnabled)
  const [copied, setCopied] = useState(false)
  const thinkingSupported = billingPlan !== 'explorer'
  // streamingVersion must be subscribed — it's the ONLY selector that triggers
  // re-renders during streaming (messages are mutated in-place for performance).
  const streamingVersion = useChatStore(s => s.streamingVersion)

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []
  const projectPath = currentProject?.path || ''

  const handleCopyMessages = useCallback(() => {
    const assistantMessages = messages
      .filter(m => m.role === 'assistant' && m.content?.trim())
      .map(m => m.content.trim())
      .join('\n\n---\n\n')
    if (!assistantMessages) return
    navigator.clipboard.writeText(assistantMessages)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [messages])

  // use-stick-to-bottom: ResizeObserver-based auto-scroll that handles
  // streaming content, expanding diffs, and dynamic height changes.
  const { scrollRef, contentRef, scrollToBottom, isAtBottom } = useStickToBottom({
    resize: 'smooth',
    initial: 'instant',
  })

  // Track whether user was at bottom before streaming started.
  // Once the user scrolls away, we stop forcing scroll until they return.
  const wasAtBottomRef = useRef(true)
  const prevStreamingRef = useRef(false)

  useEffect(() => {
    if (isAtBottom) wasAtBottomRef.current = true
  }, [isAtBottom])

  // Force scroll during streaming — compensates for ResizeObserver race
  // conditions caused by the 50ms buffer flush + in-place mutations.
  useEffect(() => {
    if (isStreaming && wasAtBottomRef.current) {
      scrollToBottom()
    }
  }, [streamingVersion, isStreaming, scrollToBottom])

  // When streaming ends, the AgentActivityIndicator unmounts (height change)
  // and the hook's "escaped from lock" may be stale. Force a final scroll.
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      if (wasAtBottomRef.current) {
        // Delay to let DOM settle after finalization + indicator unmount
        const timer = setTimeout(() => scrollToBottom(), 80)
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

  return (
    <Flex
      direction="column"
      flex="1"
      overflow="hidden"
    >
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
        <Flex align="center" gap={2}>
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
          <SessionDropdown
            projectPath={projectPath}
            activeSessionId={activeSessionId}
            isStreaming={isStreaming}
          />
          {/* Copy messages button */}
          <Box
            as="button"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="28px"
            h="28px"
            borderRadius="6px"
            color={copied ? tokens.colors.accent.green : tokens.colors.text.secondary}
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ bg: tokens.colors.bg.hoverSubtle, color: copied ? tokens.colors.accent.green : tokens.colors.text.primary }}
            onClick={handleCopyMessages}
            title={copied ? t('chat.copied') : t('chat.copyMessages')}
          >
            {copied ? <FiCheck size={14} /> : <FiClipboard size={14} />}
          </Box>
        </Flex>

        {/* Credits + Isolation + MCP indicators */}
        <HStack gap={1.5}>
          {/* Thinking toggle — only for paid plans */}
          {thinkingSupported && (
            <Flex
              as="button"
              align="center"
              gap="4px"
              px="6px"
              py="3px"
              borderRadius="5px"
              cursor="pointer"
              bg={thinkingEnabled ? 'rgba(163, 113, 247, 0.1)' : 'transparent'}
              border="1px solid"
              borderColor={thinkingEnabled ? 'rgba(163, 113, 247, 0.25)' : tokens.colors.border.default}
              color={thinkingEnabled ? tokens.colors.accent.purple : tokens.colors.text.disabled}
              transition={`all ${tokens.transition.fast}`}
              _hover={{
                bg: thinkingEnabled ? 'rgba(163, 113, 247, 0.15)' : tokens.colors.bg.hoverSubtle,
                borderColor: thinkingEnabled ? 'rgba(163, 113, 247, 0.35)' : tokens.colors.border.subtle,
              }}
              onClick={() => setThinkingEnabled(!thinkingEnabled)}
              title={thinkingEnabled ? 'Thinking ON — click to disable for faster responses' : 'Thinking OFF — click to enable deep reasoning'}
            >
              <Text fontSize="10px" fontWeight="600" letterSpacing="0.02em">
                {thinkingEnabled ? '⚡ Thinking' : 'Thinking'}
              </Text>
            </Flex>
          )}
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
        </HStack>
      </Flex>

      {/* Scaffold pipeline status banner */}
      <AnimatePresence>
        {scaffoldPhase && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
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
                  css={{ animation: 'spin 0.8s linear infinite', '@keyframes spin': { to: { transform: 'rotate(360deg)' } } }}
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
              <ChatSuggestions />
            ) : (
              <Box
                maxW="900px"
                mx="auto"
                w="100%"
                py={4}
              >
                {messages.map(msg => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    isStreaming={msg.id === streamingMessageId}
                  />
                ))}
                <AgentActivityIndicator />

                {/* Billing spillover banner — shown when user has exceeded their cycle budget */}
                {consumedPct > 1 && (
                  <Flex
                    align="center"
                    justify="center"
                    gap={2}
                    mt={3}
                    px={4}
                    py={2.5}
                    borderRadius="10px"
                    bg="rgba(247, 127, 0, 0.08)"
                    border="1px solid rgba(247, 127, 0, 0.2)"
                  >
                    <Box
                      w="8px"
                      h="8px"
                      borderRadius="full"
                      bg={tokens.colors.accent.orange}
                      flexShrink={0}
                    />
                    <Text fontSize="12px" color={tokens.colors.accent.orange} fontWeight="500">
                      {t('chat.billingSpillover')}{' '}
                      {tmsRemaining > 0
                        ? `${Math.round((consumedPct - 1) * tokenBudget / 1000).toLocaleString()}K ${t('chat.extraTokens')}`
                        : billingStatus === 'rejected'
                        ? t('chat.noCreditsRemaining')
                        : t('chat.tokensUsed')}
                    </Text>
                    {billingPlan !== 'explorer' && tmsRemaining <= 0 && (
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
            onClick={() => scrollToBottom()}
            zIndex={10}
          >
            ↓
          </Box>
        )}
        </Box>

    </Flex>
  )
}

// ─── Credit Indicator ────────────────────────────────────────────────────────

const PLAN_DISPLAY: Record<UserPlanName, { label: string; color: string }> = {
  explorer:       { label: 'Free',        color: tokens.colors.text.muted },
  pro:            { label: 'Pro',         color: tokens.colors.accent.purple },
  'business-4x':  { label: 'Business 4x', color: tokens.colors.accent.orange },
  'business-8x':  { label: 'Business 8x', color: tokens.colors.accent.primary },
}

function CreditIndicator(props: {
  plan: UserPlanName
  noCredits: boolean
  isStreaming: boolean
  consumedPct: number       // 0–1 normal, > 1 overage
  tokensConsumed: number
  tokenBudget: number
  cycleEnd: string          // "YYYY-MM-DD"
  status: CostBudgetStatus
  tmsRemaining: number
}) {
  const [showDetail, setShowDetail] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const prevPctRef = useRef(0)
  const [flash, setFlash] = useState(false)
  // Debounce the refresh button so spam-clicks don't hammer Firestore
  const lastRefreshAt = useRef(0)
  const REFRESH_DEBOUNCE_MS = 1000

  const planInfo = PLAN_DISPLAY[props.plan] || PLAN_DISPLAY.explorer
  const pct = Math.round(props.consumedPct * 100)
  // Cycle bar width is capped at 100 — overflow goes to the overage segment
  const cycleBarPct = Math.min(100, pct)
  // Overage segment shows excess beyond 100 (e.g. consumedPct=1.05 → 5%)
  const overagePct = Math.max(0, props.consumedPct - 1)
  // Show overage UI when EITHER the request was charged to TMS overage OR
  // the cycle is exhausted (consumed_pct > 1, includes spillover requests).
  const isInOverage = isInOverageState(props.status, props.consumedPct)
  const isBlocked = props.status === 'rejected'

  // Flash animation when consumedPct increases
  useEffect(() => {
    if (props.consumedPct > prevPctRef.current && prevPctRef.current > 0) {
      setFlash(true)
      const timer = setTimeout(() => setFlash(false), 600)
      return () => clearTimeout(timer)
    }
    prevPctRef.current = props.consumedPct
  }, [props.consumedPct])

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDetail) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowDetail(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDetail])

  // Color based on cost-budget status
  function getBarColor(p: number): string {
    if (p >= 1) return tokens.colors.accent.red
    if (p >= 0.95) return tokens.colors.accent.orange
    if (p >= 0.80) return '#f0b429' // yellow
    return `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.purple})`
  }

  const pillBg = isBlocked
    ? 'rgba(248, 81, 73, 0.08)'
    : isInOverage
    ? 'rgba(247, 127, 0, 0.08)'
    : 'rgba(255, 255, 255, 0.04)'

  const pillBorder = showDetail
    ? 'rgba(255, 255, 255, 0.15)'
    : isBlocked ? 'rgba(248, 81, 73, 0.2)'
    : isInOverage ? 'rgba(247, 127, 0, 0.2)'
    : 'rgba(255, 255, 255, 0.06)'

  // Format the cycle reset date — "DD MMM" or relative "in N days"
  const appLang = useSettingsStore(s => s.appLanguage)
  function formatCycleEnd(yyyymmdd: string): string {
    if (!yyyymmdd) return ''
    try {
      const date = new Date(`${yyyymmdd}T23:59:59Z`)
      const locale = appLang === 'pt' ? 'pt' : 'en'
      return date.toLocaleDateString(locale, { day: '2-digit', month: 'short' })
    } catch { return yyyymmdd }
  }
  function daysUntil(yyyymmdd: string): number {
    if (!yyyymmdd) return 0
    try {
      const date = new Date(`${yyyymmdd}T23:59:59Z`)
      return Math.max(0, Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    } catch { return 0 }
  }
  const maxUtil = props.consumedPct

  return (
    <Box position="relative" ref={ref}>
      <HStack
        gap={1.5}
        px={2}
        py="3px"
        borderRadius={tokens.radius.full}
        bg={pillBg}
        border="1px solid"
        borderColor={pillBorder}
        cursor="pointer"
        transition={`all ${tokens.transition.fast}`}
        _hover={{ bg: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.12)' }}
        onClick={() => setShowDetail(!showDetail)}
      >
        {/* Plan badge */}
        <Text fontSize="9px" fontWeight="700" color={planInfo.color} textTransform="uppercase" letterSpacing="0.04em">
          {planInfo.label}
        </Text>

        {/* Single % indicator */}
        <Text
          fontSize="10px"
          fontWeight="600"
          fontFamily={tokens.fontFamily.mono}
          color={maxUtil >= 1 ? tokens.colors.accent.red : maxUtil >= 0.95 ? tokens.colors.accent.orange : maxUtil >= 0.80 ? '#f0b429' : tokens.colors.text.secondary}
          css={flash ? {
            animation: 'creditFlash 0.6s ease',
            '@keyframes creditFlash': {
              '0%': { transform: 'scale(1)' },
              '30%': { transform: 'scale(1.2)' },
              '100%': { transform: 'scale(1)' },
            }
          } : undefined}
        >
          {props.tokenBudget > 0 ? `${pct}%` : ''}
        </Text>

        {/* Mini cycle progress bar (with overage segment if > 100) */}
        <VStack gap="1px" flexShrink={0}>
          <Box w="28px" h="3px" borderRadius="full" bg="rgba(255, 255, 255, 0.08)" overflow="hidden" position="relative">
            {props.tokenBudget > 0 && (
              <Box h="100%" borderRadius="full" bg={getBarColor(props.consumedPct)} width={`${Math.max(2, cycleBarPct)}%`} transition="width 0.5s ease" />
            )}
          </Box>
          {/* Overage segment — only when consumedPct > 1 */}
          {overagePct > 0 && (
            <Box w="28px" h="2px" borderRadius="full" bg="rgba(247, 127, 0, 0.15)" overflow="hidden">
              <Box h="100%" borderRadius="full" bg={tokens.colors.accent.orange} width={`${Math.min(100, Math.max(2, overagePct * 100))}%`} transition="width 0.5s ease" />
            </Box>
          )}
        </VStack>

        {/* Streaming pulse */}
        {props.isStreaming && (
          <Box w="5px" h="5px" borderRadius="full" bg={tokens.colors.accent.primary} flexShrink={0}
            css={{ animation: 'consumePulse 1s ease-in-out infinite', '@keyframes consumePulse': { '0%, 100%': { opacity: 0.4 }, '50%': { opacity: 1 } } }}
          />
        )}

        <FiChevronDown size={8} color={tokens.colors.text.disabled}
          style={{ transition: 'transform 0.15s', transform: showDetail ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </HStack>

      {/* Detail dropdown */}
      {showDetail && (
        <VStack
          position="absolute" top="calc(100% + 4px)" right={0} minW="260px"
          bg={tokens.colors.bg.overlay} border="1px solid" borderColor={tokens.colors.border.panel}
          borderRadius="8px" boxShadow="0 8px 24px rgba(0,0,0,0.4)" py={2} px={3} gap={2}
          zIndex={tokens.zIndex.dropdown}
        >
          {/* Plan header */}
          <Flex justify="space-between" align="center" w="100%">
            <HStack gap={1.5}>
              <Box w="6px" h="6px" borderRadius="full" bg={planInfo.color} />
              <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.primary}>{planInfo.label}</Text>
            </HStack>
            {isInOverage && (
              <Text fontSize="9px" fontWeight="700" color={tokens.colors.accent.orange} textTransform="uppercase">
                {t('chat.tmsOverage')}
              </Text>
            )}
          </Flex>

          {/* Cycle progress */}
          {props.tokenBudget > 0 && (
            <VStack gap={0.5} align="stretch" w="100%">
              <Flex justify="space-between" w="100%">
                <Text fontSize="10px" color={tokens.colors.text.muted}>{t('chat.sessionMonthly')}</Text>
                <Text fontSize="10px" fontFamily={tokens.fontFamily.mono}
                  color={props.consumedPct >= 1 ? tokens.colors.accent.red : props.consumedPct >= 0.95 ? tokens.colors.accent.orange : props.consumedPct >= 0.80 ? '#f0b429' : tokens.colors.text.secondary}>
                  {pct}%
                </Text>
              </Flex>
              {/* Cycle bar (capped at 100%) */}
              <Box w="100%" h="4px" borderRadius="full" bg="rgba(255, 255, 255, 0.06)" overflow="hidden">
                <Box h="100%" borderRadius="full"
                  bg={getBarColor(props.consumedPct)}
                  width={`${Math.max(2, cycleBarPct)}%`}
                  transition="width 0.5s ease" />
              </Box>
              {/* Overage bar (only if consumedPct > 1) */}
              {overagePct > 0 && (
                <Box w="100%" h="3px" borderRadius="full" bg="rgba(247, 127, 0, 0.12)" overflow="hidden" mt={0.5}>
                  <Box h="100%" borderRadius="full"
                    bg={tokens.colors.accent.orange}
                    width={`${Math.min(100, Math.max(2, overagePct * 100))}%`}
                    transition="width 0.5s ease" />
                </Box>
              )}
              {/* Cycle reset date — token counts removed */}
              {props.cycleEnd && (
                <Flex justify="flex-end" w="100%">
                  <Text fontSize="9px" color={tokens.colors.text.disabled}>
                    {t('chat.resetsIn')} {formatCycleEnd(props.cycleEnd)} ({daysUntil(props.cycleEnd)}d)
                  </Text>
                </Flex>
              )}
            </VStack>
          )}

          {/* TMS overage credits */}
          {props.tmsRemaining > 0 && (
            <>
              <Box w="100%" h="1px" bg={isInOverage ? 'rgba(247, 127, 0, 0.15)' : 'rgba(255, 255, 255, 0.06)'} />
              <Flex justify="space-between" w="100%">
                <Text fontSize="10px" color={isInOverage ? tokens.colors.accent.orange : tokens.colors.text.muted}>
                  {t('chat.tmsRemaining')}
                </Text>
                <Text fontSize="10px" fontWeight="700" fontFamily={tokens.fontFamily.mono}
                  color={isInOverage ? tokens.colors.accent.orange : tokens.colors.text.primary}>
                  {props.tmsRemaining}
                </Text>
              </Flex>
            </>
          )}

          {/* Blocked warning — clickable, opens studio for upgrade/purchase */}
          {isBlocked && (
            <>
              <Box w="100%" h="1px" bg="rgba(248, 81, 73, 0.15)" />
              <Box
                as="button" w="100%" py="4px" fontSize="10px"
                color={tokens.colors.accent.red}
                cursor="pointer"
                textAlign="left"
                transition={`opacity ${tokens.transition.fast}`}
                _hover={{ opacity: 0.8 }}
                onClick={() => {
                  import('@tauri-apps/plugin-opener').then(opener => {
                    opener.openUrl('https://studio.toquemedia.net').catch(() => {})
                  })
                }}
              >
                {props.plan === 'explorer' ? t('settings.upgradeForMore') : t('chat.buyTms')} →
              </Box>
            </>
          )}

          {/* Refresh button — debounced to prevent spam */}
          <Box w="100%" h="1px" bg="rgba(255, 255, 255, 0.06)" />
          <Box
            as="button" w="100%" py="4px" fontSize="10px" color={tokens.colors.text.disabled}
            cursor="pointer" transition={`color ${tokens.transition.fast}`}
            _hover={{ color: tokens.colors.text.secondary }}
            onClick={() => {
              const now = Date.now()
              if (now - lastRefreshAt.current < REFRESH_DEBOUNCE_MS) return
              lastRefreshAt.current = now
              import('../../services/auth/firebaseAuth').then(m => {
                m.default.getInstance().fetchBillingInfo()
              })
            }}
          >
            {t('chat.refreshCredits')}
          </Box>
        </VStack>
      )}
    </Box>
  )
}

// ─── Isolation Pill ──────────────────────────────────────────────────────────

function IsolationPill(props: { icon: React.ElementType; label: string; color: string; onClick?: () => void }) {
  const Icon = props.icon
  return (
    <HStack
      gap={1}
      px={2}
      py="3px"
      borderRadius={tokens.radius.full}
      bg="rgba(255, 255, 255, 0.04)"
      border="1px solid"
      borderColor="rgba(255, 255, 255, 0.06)"
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      _hover={{ bg: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.12)' }}
      onClick={props.onClick}
    >
      <Icon size={10} color={props.color} />
      <Text fontSize="10px" color={props.color} fontWeight="600" fontFamily={tokens.fontFamily.mono}>
        {props.label}
      </Text>
    </HStack>
  )
}

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
