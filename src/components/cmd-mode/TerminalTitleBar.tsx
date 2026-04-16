import { memo, useCallback, useState } from 'react'
import { Box, Flex, HStack, Text, IconButton } from '@chakra-ui/react'
import { FiCheck, FiClipboard } from 'react-icons/fi'
import { useBillingStore } from '../../stores/billingStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { CreditIndicator } from '../ui/CreditIndicator'
import { McpIndicator } from '../ui/StatusIndicators'
import { tokens } from '@/theme/tokens'
import { IS_MAC } from '@/utils/platform'

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
  const thinkingSupported = billingPlan !== 'explorer'
  const [copied, setCopied] = useState(false)

  const handleCopyContext = useCallback(async () => {
    if (!projectPath) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const context = await invoke<string>('get_project_context', { path: projectPath })
      await navigator.clipboard.writeText(context)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // silent
    }
  }, [projectPath])

  // Show basename prominently, full path dimmed
  const projectName = projectPath.split('/').filter(Boolean).pop() || projectPath

  return (
    <Flex
      px={3}
      py="6px"
      bg="rgba(0,0,0,0.45)"
      borderBottom="1px solid rgba(255,255,255,0.05)"
      align="center"
      justify="space-between"
      pl={IS_MAC ? '80px' : 3}
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
        {/* Copy context */}
        <IconButton
          aria-label="Copy project context"
          size="xs"
          variant="ghost"
          color={copied ? tokens.colors.accent.green : tokens.colors.text.disabled}
          onClick={handleCopyContext}
          minW="22px"
          h="22px"
          _hover={{ bg: 'rgba(255,255,255,0.05)', color: tokens.colors.text.secondary }}
        >
          {copied ? <FiCheck size={11} /> : <FiClipboard size={11} />}
        </IconButton>

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
