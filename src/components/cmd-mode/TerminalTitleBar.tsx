import { memo } from 'react'
import { Box, Flex, HStack, Text } from '@chakra-ui/react'
import { useBillingStore } from '../../stores/billingStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useByokStore } from '../../stores/byokStore'
import { getProfileForPlan } from '../../services/agent/modelProfiles'
import { CreditIndicator } from '../ui/CreditIndicator'
import { McpIndicator } from '../ui/StatusIndicators'
import ModelIndicator from '../chat/ModelIndicator'
import { tokens } from '@/theme/tokens'
import { IS_MAC, IS_WINDOWS, basename } from '@/utils/platform'

interface TerminalTitleBarProps {
  projectPath: string
  onBack: () => void
}

export const TerminalTitleBar = memo(function TerminalTitleBar({ projectPath, onBack }: TerminalTitleBarProps) {
  const billingPlan = useBillingStore(s => s.plan)
  const noCredits = useBillingStore(s => s.noCredits)
  const consumedPct = useBillingStore(s => s.consumedPct)
  const tokensConsumed = useBillingStore(s => s.tokensConsumed)
  const tokenBudget = useBillingStore(s => s.tokenBudget)
  const cycleEnd = useBillingStore(s => s.cycleEnd)
  const billingStatus = useBillingStore(s => s.status)
  const tmsRemaining = useBillingStore(s => s.tmsRemaining)
  const isStreaming = useChatStore(s => s.isStreaming)
  const mcpServers = useMcpStore(s => s.servers)
  const mcpIsInitializing = useMcpStore(s => s.isInitializing)
  const thinkingEnabled = useSettingsStore(s => s.thinkingEnabled)
  const backendThinkingMode = useAgentStore(s => s.thinkingMode)
  // BYOK indicator gating — mirrors ChatView so the pill swaps in for credits
  // whenever the next request would route through the user's key. CMD mode
  // uses the same AgentService singleton, so BYOK applies here too.
  const byokActive = useAgentStore(s => s.byokActive)
  const byokEnabled = useByokStore(s => s.enabled)
  const byokActiveProvider = useByokStore(s => s.activeProvider)
  const byokActiveModel = useByokStore(s => s.activeModel)
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const sessionByokSnapshot = (activeSessionId ? sessions.get(activeSessionId)?.byokSnapshot : null) ?? null
  const byokConfigured = sessionByokSnapshot !== null
    || (byokEnabled && byokActiveProvider !== null && byokActiveModel !== null)
  const showModelIndicator = byokActive || byokConfigured
  const fallbackProfile = getProfileForPlan(billingPlan)
  const effectiveMode = backendThinkingMode
    ?? (fallbackProfile.supportsThinking
        ? (fallbackProfile.thinkingMode === 'mandatory' ? 'mandatory' : 'toggleable')
        : 'none')
  const thinkingSupported = effectiveMode === 'toggleable'

  // Show basename prominently, full path dimmed (cross-platform: handles \ and /)
  const projectName = basename(projectPath) || projectPath

  return (
    <Flex
      px={3}
      py="11px"
      minH="38px"
      bg="rgba(0,0,0,0.45)"
      borderBottom="1px solid rgba(255,255,255,0.05)"
      align="center"
      justify="space-between"
      pl={IS_MAC ? '80px' : 3}
      pr={IS_WINDOWS ? '148px' : 3}
      userSelect="none"
      flexShrink={0}
      data-tauri-drag-region
    >
      {/* Left: label + project path */}
      <Flex align="center" gap={2} overflow="hidden" flex="1" minW={0} data-tauri-drag-region>
        <Text
          fontSize="10px"
          fontWeight="800"
          color={tokens.colors.accent.purple}
          fontFamily={tokens.fontFamily.mono}
          letterSpacing="0.1em"
          textTransform="uppercase"
          flexShrink={0}
        >
          ◆
        </Text>

        <Text
          fontSize="12px"
          fontWeight="600"
          color={tokens.colors.text.secondary}
          fontFamily={tokens.fontFamily.mono}
          flexShrink={0}
        >
          {projectName}
        </Text>

        <Text
          fontSize="10px"
          color={tokens.colors.text.disabled}
          fontFamily={tokens.fontFamily.mono}
          truncate
          flex="1"
          minW={0}
          opacity={0.5}
          display={{ base: 'none', md: 'block' }}
        >
          {projectPath}
        </Text>
      </Flex>

      {/* Right: controls */}
      <HStack gap={1.5} flexShrink={0}>
        {/* Thinking toggle */}
        {thinkingSupported && (
          <Box
            as="button"
            aria-label={thinkingEnabled ? 'Disable extended thinking' : 'Enable extended thinking'}
            aria-pressed={thinkingEnabled}
            px="6px"
            py="2px"
            borderRadius="3px"
            bg={thinkingEnabled ? 'rgba(163,113,247,0.1)' : 'transparent'}
            border="1px solid"
            borderColor={thinkingEnabled ? 'rgba(163,113,247,0.2)' : 'rgba(255,255,255,0.07)'}
            onClick={() => useSettingsStore.getState().setThinkingEnabled(!thinkingEnabled)}
            cursor="pointer"
            transition="all 0.12s"
            _hover={{ bg: thinkingEnabled ? 'rgba(163,113,247,0.15)' : 'rgba(255,255,255,0.04)' }}
          >
            <Text
              fontSize="9px"
              color={thinkingEnabled ? tokens.colors.accent.purple : tokens.colors.text.disabled}
              fontWeight="700"
              textTransform="uppercase"
              fontFamily={tokens.fontFamily.mono}
              letterSpacing="0.08em"
            >
              {thinkingEnabled ? '⚡ thk' : 'thk'}
            </Text>
          </Box>
        )}

        {showModelIndicator ? (
          <ModelIndicator />
        ) : (
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

        <McpIndicator servers={mcpServers} isInitializing={mcpIsInitializing} />

        {/* Exit button — keyboard equivalent: Escape (when idle / no pending permission) */}
        <Box
          as="button"
          onClick={onBack}
          aria-label="Exit CMD mode (Esc)"
          title="Exit (Esc)"
          fontSize="9px"
          fontWeight="700"
          color={tokens.colors.text.disabled}
          _hover={{ color: tokens.colors.accent.red, borderColor: 'rgba(248,81,73,0.3)' }}
          px="8px"
          py="2px"
          border="1px solid rgba(255,255,255,0.1)"
          borderRadius="3px"
          transition="all 0.1s"
          textTransform="uppercase"
          letterSpacing="0.1em"
          fontFamily={tokens.fontFamily.mono}
        >
          exit
          <Text as="span" ml="5px" opacity={0.6} fontWeight="500">esc</Text>
        </Box>
      </HStack>
    </Flex>
  )
})
