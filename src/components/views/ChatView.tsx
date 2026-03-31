import { memo, useRef, useEffect, useState, useCallback } from 'react'
import { Flex, Box, HStack, Text, VStack } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { FiSidebar, FiZap, FiBox, FiShield, FiChevronDown, FiCheck, FiAlertCircle } from 'react-icons/fi'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useChatStore } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useContainerStore } from '../../stores/containerStore'
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
  const isolationMode = useContainerStore(s => s.isolationMode)
  const devcontainerName = useContainerStore(s => s.devcontainerName)
  const scaffoldPhase = useLayoutStore(s => s.scaffoldPhase)
  const scaffoldMessage = useLayoutStore(s => s.scaffoldMessage)
  const billingPlan = useBillingStore(s => s.plan)
  const creditsRemaining = useBillingStore(s => s.creditsRemaining)
  const noCredits = useBillingStore(s => s.noCredits)
  const lastCreditsUsed = useBillingStore(s => s.lastCreditsUsed)
  const lastTokensUsed = useBillingStore(s => s.lastTokensUsed)
  const planCapacity = useBillingStore(s => s.planCapacity)
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
            creditsRemaining={creditsRemaining}
            noCredits={noCredits}
            isStreaming={isStreaming}
            lastCreditsUsed={lastCreditsUsed}
            lastTokensUsed={lastTokensUsed}
            planCapacity={planCapacity}
          />
          {isolationMode === 'docker' && (
            <IsolationPill
              icon={FiBox}
              label={devcontainerName ? `${devcontainerName} (Docker)` : t('chat.dockerIsolation')}
              color={tokens.colors.accent.greenBright}
              onClick={() => setShowAttachDialog(true)}
            />
          )}
          {isolationMode === 'app-level' && (
            <IsolationPill
              icon={FiShield}
              label={devcontainerName || t('chat.appIsolation')}
              color="#58a6ff"
              onClick={() => setShowAttachDialog(true)}
            />
          )}
          {isolationMode === 'none' && (
            <IsolationPill
              icon={FiBox}
              label={t("view.attachContainer")}
              color={tokens.colors.text.muted}
              onClick={() => setShowAttachDialog(true)}
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
  creditsRemaining: number | null
  noCredits: boolean
  isStreaming: boolean
  lastCreditsUsed: number
  lastTokensUsed: number
  planCapacity: number
}) {
  const [showDetail, setShowDetail] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const prevCreditsRef = useRef<number | null>(null)
  const [flash, setFlash] = useState(false)

  const planInfo = PLAN_DISPLAY[props.plan] || PLAN_DISPLAY.explorer
  const isLoading = props.creditsRemaining === null
  const remaining = props.creditsRemaining ?? 0
  const pct = isLoading ? 50 // neutral position while loading
    : props.planCapacity > 0 ? Math.min(100, Math.max(0, (remaining / props.planCapacity) * 100)) : 0

  // Flash animation when credits decrease
  useEffect(() => {
    if (prevCreditsRef.current !== null && props.creditsRemaining !== null
        && props.creditsRemaining < prevCreditsRef.current) {
      setFlash(true)
      const timer = setTimeout(() => setFlash(false), 600)
      return () => clearTimeout(timer)
    }
    prevCreditsRef.current = props.creditsRemaining
  }, [props.creditsRemaining])

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDetail) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowDetail(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDetail])

  // Determine credit color
  let creditColor: string = isLoading
    ? tokens.colors.text.disabled
    : tokens.colors.accent.greenBright
  if (!isLoading && props.noCredits) {
    creditColor = tokens.colors.accent.red
  } else if (!isLoading && pct <= 20) {
    creditColor = tokens.colors.accent.orange
  }

  // Progress bar color
  let barColor: string = isLoading
    ? tokens.colors.text.disabled
    : `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.purple})`
  if (!isLoading && props.noCredits) barColor = tokens.colors.accent.red
  else if (!isLoading && pct <= 20) barColor = tokens.colors.accent.orange

  return (
    <Box position="relative" ref={ref}>
      <HStack
        gap={1.5}
        px={2}
        py="3px"
        borderRadius={tokens.radius.full}
        bg={props.noCredits ? 'rgba(248, 81, 73, 0.08)' : 'rgba(255, 255, 255, 0.04)'}
        border="1px solid"
        borderColor={showDetail
          ? 'rgba(255, 255, 255, 0.15)'
          : props.noCredits ? 'rgba(248, 81, 73, 0.2)' : 'rgba(255, 255, 255, 0.06)'
        }
        cursor="pointer"
        transition={`all ${tokens.transition.fast}`}
        _hover={{ bg: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.12)' }}
        onClick={() => setShowDetail(!showDetail)}
      >
        {/* Plan badge */}
        <Text
          fontSize="9px"
          fontWeight="700"
          color={planInfo.color}
          textTransform="uppercase"
          letterSpacing="0.04em"
        >
          {planInfo.label}
        </Text>

        {/* Credits count */}
        <Text
          fontSize="10px"
          fontWeight="600"
          fontFamily={tokens.fontFamily.mono}
          color={creditColor}
          css={flash ? {
            animation: 'creditFlash 0.6s ease',
            '@keyframes creditFlash': {
              '0%': { transform: 'scale(1)' },
              '30%': { transform: 'scale(1.2)', color: tokens.colors.accent.orange },
              '100%': { transform: 'scale(1)' },
            }
          } : undefined}
        >
          {props.creditsRemaining !== null ? `${remaining}/${props.planCapacity}` : '—'}
        </Text>

        {/* Mini progress bar */}
        <Box w="24px" h="3px" borderRadius="full" bg="rgba(255, 255, 255, 0.08)" flexShrink={0} overflow="hidden">
          <Box
            h="100%"
            borderRadius="full"
            bg={barColor}
            width={`${Math.max(2, pct)}%`}
            transition="width 0.5s ease"
          />
        </Box>

        {/* Streaming consumption indicator */}
        {props.isStreaming && (
          <Box
            w="5px"
            h="5px"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            flexShrink={0}
            css={{
              animation: 'consumePulse 1s ease-in-out infinite',
              '@keyframes consumePulse': {
                '0%, 100%': { opacity: 0.4 },
                '50%': { opacity: 1 },
              }
            }}
          />
        )}

        <FiChevronDown
          size={8}
          color={tokens.colors.text.disabled}
          style={{
            transition: 'transform 0.15s',
            transform: showDetail ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </HStack>

      {/* Detail dropdown */}
      {showDetail && (
        <VStack
          position="absolute"
          top="calc(100% + 4px)"
          right={0}
          minW="220px"
          bg={tokens.colors.bg.overlay}
          border="1px solid"
          borderColor={tokens.colors.border.panel}
          borderRadius="8px"
          boxShadow="0 8px 24px rgba(0,0,0,0.4)"
          py={2}
          px={3}
          gap={2}
          zIndex={tokens.zIndex.dropdown}
        >
          {/* Plan + credits header */}
          <Flex justify="space-between" align="center" w="100%">
            <HStack gap={1.5}>
              <Box w="6px" h="6px" borderRadius="full" bg={planInfo.color} />
              <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.primary}>
                {planInfo.label}
              </Text>
            </HStack>
            <Text fontSize="11px" fontWeight="700" fontFamily={tokens.fontFamily.mono} color={creditColor}>
              {props.creditsRemaining !== null ? `${remaining} / ${props.planCapacity} TMS` : '—'}
            </Text>
          </Flex>

          {/* Progress bar */}
          <Box w="100%" h="3px" borderRadius="full" bg="rgba(255, 255, 255, 0.06)" overflow="hidden">
            <Box
              h="100%"
              borderRadius="full"
              bg={barColor}
              width={`${Math.max(2, pct)}%`}
              transition="width 0.5s ease"
            />
          </Box>

          {/* Plan type label */}
          <Text fontSize="10px" color={tokens.colors.text.disabled}>
            {props.plan === 'explorer'
              ? t('settings.dailyCredits')
              : t('settings.monthlyCredits')
            }
          </Text>

          {/* Last consumption (shown after a message completes) */}
          {props.lastCreditsUsed > 0 && (
            <>
              <Box w="100%" h="1px" bg="rgba(255, 255, 255, 0.06)" />
              <VStack gap={1} align="stretch" w="100%">
                <Text fontSize="10px" fontWeight="600" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.04em">
                  {t('chat.lastMessage')}
                </Text>
                <Flex justify="space-between" w="100%">
                  <Text fontSize="10px" color={tokens.colors.text.secondary}>TMS</Text>
                  <Text fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.accent.orange}>
                    -{props.lastCreditsUsed}
                  </Text>
                </Flex>
                {props.lastTokensUsed > 0 && (
                  <Flex justify="space-between" w="100%">
                    <Text fontSize="10px" color={tokens.colors.text.secondary}>Tokens</Text>
                    <Text fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.text.muted}>
                      {props.lastTokensUsed.toLocaleString()}
                    </Text>
                  </Flex>
                )}
              </VStack>
            </>
          )}

          {/* No credits warning */}
          {props.noCredits && (
            <>
              <Box w="100%" h="1px" bg="rgba(248, 81, 73, 0.15)" />
              <Text fontSize="10px" color={tokens.colors.accent.red}>
                {props.plan === 'explorer'
                  ? t('settings.upgradeForMore')
                  : t('settings.buyMore')
                }
              </Text>
            </>
          )}

          {/* Refresh button */}
          <Box w="100%" h="1px" bg="rgba(255, 255, 255, 0.06)" />
          <Box
            as="button"
            w="100%"
            py="4px"
            fontSize="10px"
            color={tokens.colors.text.disabled}
            cursor="pointer"
            transition={`color ${tokens.transition.fast}`}
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
