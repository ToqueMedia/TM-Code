import { memo } from 'react'
import { Box, Flex, HStack, Text } from '@chakra-ui/react'
import { useBillingStore } from '../../stores/billingStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useChatStore } from '../../stores/chatStore'
import { useByokState } from '../../hooks/useByokState'
import { useThinkingToggle } from '../../hooks/useThinkingToggle'
import { CreditIndicator } from '../ui/CreditIndicator'
// Thinking toggle removed (claude-vaz parity). The "thk" pill below renders
// only as a static badge when the backend reports mandatory-thinking models.
import { McpIndicator } from '../ui/StatusIndicators'
import ModelIndicator from '../chat/ModelIndicator'
import { tokens } from '@/theme/tokens'
import { basename } from '@/utils/platform'
import { useTranslation } from '@/i18n/useTranslation'

interface TerminalTitleBarProps {
  projectPath: string
  onBack: () => void
}

export const TerminalTitleBar = memo(function TerminalTitleBar({ projectPath, onBack }: TerminalTitleBarProps) {
  const t = useTranslation()
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
  // BYOK state via shared hook so this component never drifts from
  // AgentStatusBar / ChatView. CMD mode uses the same AgentService
  // singleton, so BYOK rules apply identically here.
  const { byokInPlay: showModelIndicator } = useByokState()
  // Mandatory-thinking badge only — interactive toggle was removed
  // (claude-vaz parity). Slash commands force reasoning ON via server-side
  // X-Request-Type header; the user does not flip thinking mid-session.
  const { mandatory: thinkingMandatory } = useThinkingToggle()

  // Show basename prominently, full path dimmed (cross-platform: handles \ and /)
  const projectName = basename(projectPath) || projectPath

  return (
    <Flex
      px={3}
      py="11px"
      minH="38px"
      bg={tokens.colors.terminal.titlebarBg}
      borderBottom={`1px solid ${tokens.colors.terminal.chromeHairline}`}
      align="center"
      justify="space-between"
      userSelect="none"
      flexShrink={0}
      data-ui-chrome
    >
      {/* Left: label + project path */}
      <Flex align="center" gap={2} overflow="hidden" flex="1" minW={0}>
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
        {/* Mandatory-thinking badge — static, not interactive. Renders only
            when the backend reports the active model thinks unconditionally. */}
        {thinkingMandatory && (
          <Box
            px="6px"
            py="2px"
            borderRadius={tokens.radius.sm}
            bg="rgba(163,113,247,0.1)"
            border="1px solid rgba(163,113,247,0.2)"
            title={t('terminalMode.titlebar.thinkingAlwaysOn')}
          >
            {/* Refined-terminal: emoji '⚡' dropped for a single-color text
                diamond glyph in the same purple accent. */}
            <Text
              fontSize="9px"
              color={tokens.colors.accent.purple}
              fontWeight="700"
              textTransform="uppercase"
              fontFamily={tokens.fontFamily.mono}
              letterSpacing="0.08em"
            >
              ◆ thk
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
          aria-label={t('terminalMode.titlebar.exitAria')}
          title={t('terminalMode.titlebar.exitTooltip')}
          fontSize="9px"
          fontWeight="700"
          color={tokens.colors.text.disabled}
          _hover={{ color: tokens.colors.accent.red, borderColor: 'rgba(248,81,73,0.3)' }}
          px="8px"
          py="2px"
          border="1px solid rgba(255,255,255,0.1)"
          borderRadius={tokens.radius.sm}
          transition="color 0.1s"
          textTransform="uppercase"
          letterSpacing="0.1em"
          fontFamily={tokens.fontFamily.mono}
        >
          {t('terminalMode.titlebar.exitLabel')}
          <Text as="span" ml="5px" opacity={0.6} fontWeight="500">esc</Text>
        </Box>
      </HStack>
    </Flex>
  )
})
