import { Box, HStack, Text } from '@chakra-ui/react'
import { FiKey } from 'react-icons/fi'
import { useAgentStore } from '../../stores/agentStore'
import { useByokStore } from '../../stores/byokStore'
import { useChatStore } from '../../stores/chatStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { tokens } from '@/theme/tokens'

// ── ModelIndicator ──
//
// Shown in the chat header when BYOK is in effect — either CONFIGURED locally
// (active provider/model selected and master toggle on) or CONFIRMED by the
// server (X-BYOK-Active response header on the most recent reply).
//
// Two states with subtle visual difference:
//   - configured (no response yet): muted pink, border = 0.25 alpha
//   - confirmed (server replied with X-BYOK-Active=true): full pink, border = 0.4 alpha
//
// Without the configured-state preview, the user has no visual feedback that
// BYOK will route their next request — the CreditIndicator stays visible and
// it looks like nothing changed.
//
// Click opens Settings → API Keys.

export default function ModelIndicator() {
  // Server-confirmed state — authoritative for what the LAST response used
  const byokActive = useAgentStore(s => s.byokActive)
  const modelName = useAgentStore(s => s.modelName)
  const modelProvider = useAgentStore(s => s.modelProvider)

  // Local configured state — what BYOK WOULD route through if a request
  // were sent now. Honour the active session's snapshot first, then fall
  // back to the global byokStore selection (matches agentService logic).
  const activeSession = useChatStore(s => s.activeSessionId ? s.sessions.get(s.activeSessionId) ?? null : null)
  const sessionSnapshot = activeSession?.byokSnapshot ?? null
  const enabled = useByokStore(s => s.enabled)
  const activeProvider = useByokStore(s => s.activeProvider)
  const activeModel = useByokStore(s => s.activeModel)
  const providers = useByokStore(s => s.providers)

  const configured = (() => {
    if (sessionSnapshot) {
      return { providerId: sessionSnapshot.providerId, modelId: sessionSnapshot.modelId }
    }
    if (enabled && activeProvider && activeModel) {
      return { providerId: activeProvider, modelId: activeModel }
    }
    return null
  })()

  if (!byokActive && !configured) return null

  // Prefer server-reported model when available, fall back to local config.
  // Display format is `Model (BYOK)` — provider name moves to the tooltip
  // (it's redundant in the pill since the user knows which provider their
  // active model belongs to, and shorter labels fit more chat headers).
  let labelModel: string | null = null
  let labelProvider: string | null = null
  if (byokActive) {
    labelModel = modelName
    labelProvider = modelProvider
  } else if (configured) {
    const providerEntry = providers.find(p => p.id === configured.providerId)
    labelProvider = providerEntry?.name ?? configured.providerId
    labelModel = configured.modelId
  }
  const label = labelModel ? `${labelModel} (BYOK)` : 'BYOK'

  // Subtle distinction: pending preview vs server-confirmed.
  const isConfirmed = byokActive
  const bg = isConfirmed ? 'rgba(254, 16, 99, 0.14)' : 'rgba(254, 16, 99, 0.06)'
  const borderColor = isConfirmed ? 'rgba(254, 16, 99, 0.4)' : 'rgba(254, 16, 99, 0.2)'
  const hoverBg = isConfirmed ? 'rgba(254, 16, 99, 0.2)' : 'rgba(254, 16, 99, 0.12)'
  const hoverBorder = isConfirmed ? 'rgba(254, 16, 99, 0.55)' : 'rgba(254, 16, 99, 0.35)'
  const providerSuffix = labelProvider ? ` · ${labelProvider}` : ''
  const titleText = isConfirmed
    ? `BYOK active${providerSuffix} — click to manage in Settings`
    : `BYOK configured${providerSuffix} — your next request will use this provider. Click to manage.`

  return (
    <HStack
      as="button"
      gap={1}
      px={2}
      py="3px"
      borderRadius={tokens.radius.full}
      bg={bg}
      border="1px solid"
      borderColor={borderColor}
      cursor="pointer"
      transition={tokens.transition.fast}
      _hover={{ bg: hoverBg, borderColor: hoverBorder }}
      onClick={() => useLayoutStore.getState().setViewMode('settings')}
      title={titleText}
    >
      <Box color={tokens.colors.accent.primary} opacity={isConfirmed ? 1 : 0.7}>
        <FiKey size={10} />
      </Box>
      <Text
        fontSize="10px"
        fontWeight="600"
        color={tokens.colors.accent.primary}
        fontFamily={tokens.fontFamily.mono}
        opacity={isConfirmed ? 1 : 0.85}
        maxW="180px"
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
      >
        {label}
      </Text>
    </HStack>
  )
}
