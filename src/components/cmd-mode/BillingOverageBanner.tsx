import { memo } from 'react'
import { Flex, Text } from '@chakra-ui/react'
import { useBillingStore } from '../../stores/billingStore'
import { useAgentStore } from '../../stores/agentStore'
import { useByokStore } from '../../stores/byokStore'
import { useChatStore } from '../../stores/chatStore'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'

export const BillingOverageBanner = memo(function BillingOverageBanner() {
  const t = useTranslation()
  const consumedPct = useBillingStore(s => s.consumedPct)
  // Mirror ChatView's BYOK gating so the message tells the truth: when BYOK
  // routes the request, "agent may be throttled" is wrong — the user's own
  // key is serving the requests, the platform's throttle doesn't apply.
  const byokActive = useAgentStore(s => s.byokActive)
  const byokEnabled = useByokStore(s => s.enabled)
  const byokActiveProvider = useByokStore(s => s.activeProvider)
  const byokActiveModel = useByokStore(s => s.activeModel)
  const activeSessionId = useChatStore(s => s.activeSessionId)
  const sessions = useChatStore(s => s.sessions)
  const sessionByokSnapshot = (activeSessionId ? sessions.get(activeSessionId)?.byokSnapshot : null) ?? null
  const byokInUse = byokActive
    || sessionByokSnapshot !== null
    || (byokEnabled && byokActiveProvider !== null && byokActiveModel !== null)

  if (consumedPct <= 1) return null

  // Refined-terminal: flat full-width warning LINE — no rounded card, no fill
  // box, no shadow. Semantic yellow (terminal.yellow) foreground reads as a
  // native terminal warning; the existing low-alpha bg + 1px hairline is the
  // only separation cue.
  return (
    <Flex
      align="center"
      gap={2}
      px={3}
      py="5px"
      bg="rgba(247,127,0,0.06)"
      borderBottom={`1px solid ${tokens.colors.terminal.chromeHairlineFaint}`}
      flexShrink={0}
      data-tauri-drag-region
    >
      <Text fontSize="11px" color={tokens.colors.terminal.yellow} fontFamily={tokens.fontFamily.mono} fontWeight="700">!</Text>
      <Text fontSize="11px" color={tokens.colors.terminal.yellow} fontFamily={tokens.fontFamily.mono} opacity={0.9}>
        {byokInUse
          ? t('chat.byokOverBudget')
          : t('terminalMode.billing.overBudget')}
      </Text>
    </Flex>
  )
})
