import { Box, HStack, Text } from '@chakra-ui/react'
import { FiKey } from 'react-icons/fi'
import { useAgentStore } from '../../stores/agentStore'
import { useByokStore } from '../../stores/byokStore'
import { useChatStore } from '../../stores/chatStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { tokens } from '@/theme/tokens'

// ── ModelIndicator ──
//
// Always shown in the chat header once the backend has reported a model name
// (via the X-Model-Name response header). Three visual states:
//   - byok confirmed (X-BYOK-Active=true): full pink, key icon, "Model (BYOK)"
//   - byok configured (local toggle on, no reply yet): muted pink preview
//   - cloud (default): neutral grey-on-glass, model name only — no key icon
//
// User feedback: "Só revela o modelo se usar o BYOK" — the developer wants to
// know which model the IDE is talking to regardless of routing, so this no
// longer gates on BYOK state alone.

export default function ModelIndicator() {
  // Server-confirmed state — authoritative for what the LAST response used
  const byokActive = useAgentStore(s => s.byokActive)
  const modelName = useAgentStore(s => s.modelName)
  const modelProvider = useAgentStore(s => s.modelProvider)

  // Local configured state — what BYOK WOULD route through if a request
  // were sent now. Honour the active session's snapshot first, then fall
  // back to the global byokStore selection. Other call-sites (AgentStatusBar,
  // TerminalTitleBar, ChatView, agentService) consume the equivalent gate
  // via the `useByokState()` hook — this one keeps the inline computation
  // because it also needs the provider/model IDs to render the pill, not
  // just the boolean.
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

  // Render nothing only when the backend hasn't replied yet AND nothing is
  // configured locally. The cloud branch needs at least `modelName` from the
  // most recent response header to have something to display.
  if (!byokActive && !configured && !modelName) return null

  // Pick the active mode. Order matters: BYOK confirmed > BYOK configured (preview)
  // > cloud. `byokActive` is server-authoritative; `configured` is local intent
  // before any reply has been seen.
  const mode: 'byok-confirmed' | 'byok-configured' | 'cloud' =
    byokActive ? 'byok-confirmed' : configured ? 'byok-configured' : 'cloud'

  let labelModel: string | null = null
  let labelProvider: string | null = null
  if (mode === 'byok-confirmed') {
    labelModel = modelName
    labelProvider = modelProvider
  } else if (mode === 'byok-configured' && configured) {
    const providerEntry = providers.find(p => p.id === configured.providerId)
    labelProvider = providerEntry?.name ?? configured.providerId
    labelModel = configured.modelId
  } else {
    labelModel = modelName
    labelProvider = modelProvider
  }

  // BYOK pills append "(BYOK)"; cloud pill is just the model name.
  const label = mode === 'cloud'
    ? (labelModel ?? '')
    : (labelModel ? `${labelModel} (BYOK)` : 'BYOK')

  // Per-mode palette. Cloud uses a neutral glass look so it doesn't compete
  // with the pink BYOK pill — the developer can tell at a glance which path
  // the IDE is on.
  const palette = mode === 'cloud'
    ? {
        bg: tokens.colors.bg.glass,
        borderColor: tokens.colors.border.glass,
        hoverBg: tokens.colors.bg.hoverSubtle,
        hoverBorder: tokens.colors.border.panel,
        textColor: tokens.colors.text.secondary,
        textOpacity: 1,
        icon: null as null | typeof FiKey,
        iconOpacity: 1,
      }
    : mode === 'byok-confirmed'
      ? {
          bg: 'rgba(254, 16, 99, 0.14)',
          borderColor: 'rgba(254, 16, 99, 0.4)',
          hoverBg: 'rgba(254, 16, 99, 0.2)',
          hoverBorder: 'rgba(254, 16, 99, 0.55)',
          textColor: tokens.colors.accent.primary,
          textOpacity: 1,
          icon: FiKey,
          iconOpacity: 1,
        }
      : {
          bg: 'rgba(254, 16, 99, 0.06)',
          borderColor: 'rgba(254, 16, 99, 0.2)',
          hoverBg: 'rgba(254, 16, 99, 0.12)',
          hoverBorder: 'rgba(254, 16, 99, 0.35)',
          textColor: tokens.colors.accent.primary,
          textOpacity: 0.85,
          icon: FiKey,
          iconOpacity: 0.7,
        }

  const providerSuffix = labelProvider ? ` · ${labelProvider}` : ''
  const titleText =
    mode === 'byok-confirmed' ? `BYOK active${providerSuffix} — click to manage in Settings`
    : mode === 'byok-configured' ? `BYOK configured${providerSuffix} — your next request will use this provider. Click to manage.`
    : `Model in use${providerSuffix}`

  return (
    <HStack
      as="button"
      gap={1}
      px={2}
      py="3px"
      borderRadius={tokens.radius.full}
      bg={palette.bg}
      border="1px solid"
      borderColor={palette.borderColor}
      cursor="pointer"
      transition={tokens.transition.fast}
      _hover={{ bg: palette.hoverBg, borderColor: palette.hoverBorder }}
      onClick={() => useLayoutStore.getState().setViewMode('settings')}
      title={titleText}
    >
      {palette.icon && (
        <Box color={tokens.colors.accent.primary} opacity={palette.iconOpacity}>
          <palette.icon size={10} />
        </Box>
      )}
      <Text
        fontSize="10px"
        fontWeight="600"
        color={palette.textColor}
        fontFamily={tokens.fontFamily.mono}
        opacity={palette.textOpacity}
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
