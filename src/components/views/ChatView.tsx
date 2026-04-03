import { memo, useRef, useEffect, useState, useCallback } from 'react'
import { Flex, Box, HStack, Text, VStack } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { FiSidebar, FiZap, FiShield, FiChevronDown, FiCheck, FiAlertCircle } from 'react-icons/fi'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useChatStore } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useBillingStore, type UserPlanName } from '../../stores/billingStore'
import MessageBubble from '../chat/MessageBubble'
import AgentActivityIndicator from '../chat/AgentActivityIndicator'
import ChatSkeleton from '../chat/ChatSkeleton'
import AttachContainerDialog from '../chat/AttachContainerDialog'
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
  const envelope5hUtil = useBillingStore(s => s.envelope5hUtilization)
  const envelope7dUtil = useBillingStore(s => s.envelope7dUtilization)
  const envelope5hReset = useBillingStore(s => s.envelope5hReset)
  const envelope7dReset = useBillingStore(s => s.envelope7dReset)
  const envelopeStatus = useBillingStore(s => s.envelopeStatus)
  const tmsStatus = useBillingStore(s => s.tmsStatus)
  const tmsRemaining = useBillingStore(s => s.tmsRemaining)
  const usingTmsOverage = useBillingStore(s => s.usingTmsOverage)
  const lastEffectiveTokens = useBillingStore(s => s.lastEffectiveTokens)
  const lastTokensUsed = useBillingStore(s => s.lastTokensUsed)
  const modelMultiplier = useBillingStore(s => s.modelMultiplier)
  const envelopeMonthlyLimit = useBillingStore(s => s.envelopeMonthlyLimit)
  const envelopeMonthlyConsumed = useBillingStore(s => s.envelopeMonthlyConsumed)
  const [showAttachDialog, setShowAttachDialog] = useState(false)
  // streamingVersion must be subscribed — it's the ONLY selector that triggers
  // re-renders during streaming (messages are mutated in-place for performance).
  const streamingVersion = useChatStore(s => s.streamingVersion)

  const session = activeSessionId ? sessions.get(activeSessionId) : null
  const messages = session?.messages || []
  const projectPath = currentProject?.path || ''

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
        </Flex>

        {/* Credits + Isolation + MCP indicators */}
        <HStack gap={1.5}>
          <CreditIndicator
            plan={billingPlan}
            noCredits={noCredits}
            isStreaming={isStreaming}
            envelope5hUtil={envelope5hUtil}
            envelope7dUtil={envelope7dUtil}
            envelope5hReset={envelope5hReset}
            envelope7dReset={envelope7dReset}
            envelopeStatus={envelopeStatus}
            tmsStatus={tmsStatus}
            tmsRemaining={tmsRemaining}
            usingTmsOverage={usingTmsOverage}
            lastEffectiveTokens={lastEffectiveTokens}
            lastTokensUsed={lastTokensUsed}
            modelMultiplier={modelMultiplier}
            envelopeMonthlyLimit={envelopeMonthlyLimit}
            envelopeMonthlyConsumed={envelopeMonthlyConsumed}
          />
          {sandboxEnabled && (
            <IsolationPill
              icon={FiShield}
              label="Modo Sandbox"
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

        <Box
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-label={t("chat.messages")}
          flex="1"
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
              </Box>
            )}
          </Box>
        </Box>

      {/* Attach Container Dialog */}
      <AttachContainerDialog
        isOpen={showAttachDialog}
        onClose={() => setShowAttachDialog(false)}
      />
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
  envelope5hUtil: number
  envelope7dUtil: number
  envelope5hReset: number
  envelope7dReset: number
  envelopeStatus: string
  tmsStatus: string
  tmsRemaining: number
  usingTmsOverage: boolean
  lastEffectiveTokens: number
  lastTokensUsed: number
  modelMultiplier: number
  envelopeMonthlyLimit: number
  envelopeMonthlyConsumed: number
}) {
  const [showDetail, setShowDetail] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const prev5hRef = useRef(0)
  const [flash, setFlash] = useState(false)

  const planInfo = PLAN_DISPLAY[props.plan] || PLAN_DISPLAY.explorer
  const h5Pct = Math.round(props.envelope5hUtil * 100)
  const d7Pct = Math.round(props.envelope7dUtil * 100)
  const maxUtil = Math.max(props.envelope5hUtil, props.envelope7dUtil)
  const isBlocked = props.envelopeStatus === 'rejected' && props.tmsStatus === 'rejected'

  // Flash animation when 5h utilization increases
  useEffect(() => {
    if (props.envelope5hUtil > prev5hRef.current && prev5hRef.current > 0) {
      setFlash(true)
      const timer = setTimeout(() => setFlash(false), 600)
      return () => clearTimeout(timer)
    }
    prev5hRef.current = props.envelope5hUtil
  }, [props.envelope5hUtil])

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDetail) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowDetail(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDetail])

  // Color based on envelope status
  function getBarColor(util: number): string {
    if (util >= 1) return tokens.colors.accent.red
    if (util >= 0.8) return tokens.colors.accent.orange
    return `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.purple})`
  }

  const pillBg = isBlocked
    ? 'rgba(248, 81, 73, 0.08)'
    : props.usingTmsOverage
    ? 'rgba(247, 127, 0, 0.08)'
    : 'rgba(255, 255, 255, 0.04)'

  const pillBorder = showDetail
    ? 'rgba(255, 255, 255, 0.15)'
    : isBlocked ? 'rgba(248, 81, 73, 0.2)'
    : props.usingTmsOverage ? 'rgba(247, 127, 0, 0.2)'
    : 'rgba(255, 255, 255, 0.06)'

  // Format reset: "4h 52min" for <24h, "qua, 11:49" for >=24h
  function formatReset(epoch: number): string {
    if (!epoch) return ''
    const diff = epoch - Math.floor(Date.now() / 1000)
    if (diff <= 0) return 'agora'
    if (diff < 86400) {
      const h = Math.floor(diff / 3600)
      const m = Math.ceil((diff % 3600) / 60)
      return h > 0 ? `${h}h ${m}min` : `${m}min`
    }
    // Show weekday + time for >=24h
    const resetDate = new Date(epoch * 1000)
    const weekday = resetDate.toLocaleDateString('pt', { weekday: 'short' }).replace('.', '')
    const time = resetDate.toLocaleTimeString('pt', { hour: '2-digit', minute: '2-digit' })
    return `${weekday}, ${time}`
  }

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

        {/* 5h + 7d utilization compact */}
        <Text
          fontSize="10px"
          fontWeight="600"
          fontFamily={tokens.fontFamily.mono}
          color={maxUtil >= 1 ? tokens.colors.accent.red : maxUtil >= 0.8 ? tokens.colors.accent.orange : tokens.colors.text.secondary}
          css={flash ? {
            animation: 'creditFlash 0.6s ease',
            '@keyframes creditFlash': {
              '0%': { transform: 'scale(1)' },
              '30%': { transform: 'scale(1.2)' },
              '100%': { transform: 'scale(1)' },
            }
          } : undefined}
        >
          {props.usingTmsOverage ? `TMS: ${props.tmsRemaining}` : props.envelope5hReset > 0 ? `${100 - h5Pct}%` : ''}
        </Text>

        {/* Mini dual progress bars — empty when no active session, fills as tokens are used */}
        <VStack gap="1px" flexShrink={0}>
          <Box w="20px" h="2px" borderRadius="full" bg="rgba(255, 255, 255, 0.08)" overflow="hidden">
            {props.envelope5hReset > 0 && (
              <Box h="100%" borderRadius="full" bg={getBarColor(props.envelope5hUtil)} width={`${Math.max(2, 100 - h5Pct)}%`} transition="width 0.5s ease" />
            )}
          </Box>
          <Box w="20px" h="2px" borderRadius="full" bg="rgba(255, 255, 255, 0.08)" overflow="hidden">
            {props.envelope7dReset > 0 && (
              <Box h="100%" borderRadius="full" bg={getBarColor(props.envelope7dUtil)} width={`${Math.max(2, 100 - d7Pct)}%`} transition="width 0.5s ease" />
            )}
          </Box>
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
          position="absolute" top="calc(100% + 4px)" right={0} minW="240px"
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
            {props.usingTmsOverage && (
              <Text fontSize="9px" fontWeight="700" color={tokens.colors.accent.orange} textTransform="uppercase">
                {t('chat.tmsOverage')}
              </Text>
            )}
          </Flex>

          {/* 5h session window — bar shows REMAINING (inverted) */}
          {(() => {
            const hasActiveSession = props.envelope5hReset > 0
            return (
              <VStack gap={0.5} align="stretch" w="100%">
                <Flex justify="space-between" w="100%">
                  <Text fontSize="10px" color={tokens.colors.text.muted}>{t('chat.sessionCurrent')}</Text>
                  {hasActiveSession ? (
                    <Text fontSize="10px" fontFamily={tokens.fontFamily.mono}
                      color={props.envelope5hUtil >= 1 ? tokens.colors.accent.red : props.envelope5hUtil >= 0.8 ? tokens.colors.accent.orange : tokens.colors.text.secondary}>
                      {100 - h5Pct}%
                    </Text>
                  ) : (
                    <Text fontSize="10px" color={tokens.colors.accent.greenBright}>{t('chat.available')}</Text>
                  )}
                </Flex>
                <Box w="100%" h="3px" borderRadius="full" bg="rgba(255, 255, 255, 0.06)" overflow="hidden">
                  {hasActiveSession && (
                    <Box h="100%" borderRadius="full"
                      bg={getBarColor(props.envelope5hUtil)}
                      width={`${Math.max(2, 100 - h5Pct)}%`}
                      transition="width 0.5s ease" />
                  )}
                </Box>
                <Text fontSize="9px" color={tokens.colors.text.disabled}>
                  {hasActiveSession ? `${t('chat.resetsIn')} ${formatReset(props.envelope5hReset)}` : t('chat.noActiveSession')}
                </Text>
              </VStack>
            )
          })()}

          {/* 7d weekly window — bar shows REMAINING (inverted) */}
          {(() => {
            const hasActiveWeek = props.envelope7dReset > 0
            return (
              <VStack gap={0.5} align="stretch" w="100%">
                <Flex justify="space-between" w="100%">
                  <Text fontSize="10px" color={tokens.colors.text.muted}>{t('chat.sessionWeekly')}</Text>
                  {hasActiveWeek ? (
                    <Text fontSize="10px" fontFamily={tokens.fontFamily.mono}
                      color={props.envelope7dUtil >= 1 ? tokens.colors.accent.red : props.envelope7dUtil >= 0.8 ? tokens.colors.accent.orange : tokens.colors.text.secondary}>
                      {100 - d7Pct}%
                    </Text>
                  ) : (
                    <Text fontSize="10px" color={tokens.colors.accent.greenBright}>{t('chat.available')}</Text>
                  )}
                </Flex>
                <Box w="100%" h="3px" borderRadius="full" bg="rgba(255, 255, 255, 0.06)" overflow="hidden">
                  {hasActiveWeek && (
                    <Box h="100%" borderRadius="full"
                      bg={getBarColor(props.envelope7dUtil)}
                      width={`${Math.max(2, 100 - d7Pct)}%`}
                      transition="width 0.5s ease" />
                  )}
                </Box>
                <Text fontSize="9px" color={tokens.colors.text.disabled}>
                  {hasActiveWeek ? `${t('chat.resetsIn')} ${formatReset(props.envelope7dReset)}` : t('chat.noActiveSession')}
                </Text>
              </VStack>
            )
          })()}

          {/* TMS overage info (only when active) */}
          {props.usingTmsOverage && (
            <>
              <Box w="100%" h="1px" bg="rgba(247, 127, 0, 0.15)" />
              <Flex justify="space-between" w="100%">
                <Text fontSize="10px" color={tokens.colors.accent.orange}>{t('chat.tmsRemaining')}</Text>
                <Text fontSize="10px" fontWeight="700" fontFamily={tokens.fontFamily.mono} color={tokens.colors.accent.orange}>
                  {props.tmsRemaining}
                </Text>
              </Flex>
            </>
          )}

          {/* Blocked warning */}
          {isBlocked && (
            <>
              <Box w="100%" h="1px" bg="rgba(248, 81, 73, 0.15)" />
              <Text fontSize="10px" color={tokens.colors.accent.red}>
                {props.plan === 'explorer' ? t('settings.upgradeForMore') : t('chat.buyTms')}
              </Text>
            </>
          )}

          {/* Refresh button */}
          <Box w="100%" h="1px" bg="rgba(255, 255, 255, 0.06)" />
          <Box
            as="button" w="100%" py="4px" fontSize="10px" color={tokens.colors.text.disabled}
            cursor="pointer" transition={`color ${tokens.transition.fast}`}
            _hover={{ color: tokens.colors.text.secondary }}
            onClick={() => {
              import('../../services/auth/firebaseAuth').then(m => {
                const auth = m.default.getInstance()
                ;(auth as any).lastBillingFetchMs = 0
                ;(auth as any).fetchBillingInfo(Date.now())
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
