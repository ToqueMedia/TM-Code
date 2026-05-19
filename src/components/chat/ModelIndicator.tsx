import { memo } from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'
import { FiKey } from 'react-icons/fi'
import { useAgentStore } from '../../stores/agentStore'
import { useBillingStore } from '../../stores/billingStore'
import { useByokStore } from '../../stores/byokStore'
import { useChatStore } from '../../stores/chatStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { tokens } from '@/theme/tokens'

/**
 * Plans that surface the cloud model name in the pill. Today only the
 * future `mimo-orbit` plan (still to be created) qualifies — its whole
 * value proposition is "you're talking to a specific MiMo SKU via the
 * Orbit Program", so the developer wants the model identity visible. The
 * other plans (`explorer`, `vibe`, `pro`, `max`) route through a
 * platform-managed model that the user did not choose and does not
 * benefit from seeing in the header. Cast to `string` so this compiles
 * before `UserPlanName` is extended to include the new plan id —
 * remove the cast once `'mimo-orbit'` is part of the union.
 */
function planShowsCloudModel(plan: string | null | undefined): boolean {
  return plan === 'mimo-orbit'
}

// ── ModelIndicator ──
//
// Renders when EITHER:
//  - the user is on the BYOK path — confirmed (server set
//    X-BYOK-Active=true) or configured (local toggle on, awaiting confirm), OR
//  - the plan opts in to surfacing the cloud model name (see
//    `planShowsCloudModel`). Today that's `mimo-orbit` only.
//
// All other plans (`explorer`, `vibe`, `pro`, `max`) hide the pill —
// per user feedback the cloud model name added chrome without value when
// the routing is the platform default. The model identity is still
// inspectable via the ContextWindowIndicator tooltip and Settings → Profile.

function ModelIndicator() {
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

  // Plan-opt-in for cloud model surfacing — currently only `mimo-orbit`.
  // Subscribed AT the component (not inside the early-return) so the pill
  // appears/disappears reactively when the plan handshake completes.
  const plan = useBillingStore((s) => s.plan)
  const cloudVisible = planShowsCloudModel(plan)

  // Hide the pill entirely when:
  //   - not on BYOK (neither confirmed nor configured), AND
  //   - the plan doesn't opt in to cloud surfacing, OR
  //   - we still don't have a model name from the backend (pre-handshake).
  if (!byokActive && !configured && !cloudVisible) return null
  if (!byokActive && !configured && cloudVisible && !modelName) return null

  // Pick the active mode. Order matters: BYOK confirmed (server-authoritative)
  // > BYOK configured (local intent only) > cloud (opt-in plan).
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
      onClick={() => {
        // Land on Chave API (BYOK), not Profile & Plan — clicking the
        // model pill is always BYOK-shaped intent: "manage which provider
        // serves my requests". Seed the pending section BEFORE switching
        // view mode so SettingsView's useState initializer picks it up on
        // first render. The flag is consumed-once and cleared on mount.
        const layout = useLayoutStore.getState()
        layout.setSettingsInitialSection('apiKeys')
        layout.setViewMode('settings')
      }}
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

// Header pill — re-renders on every streaming-token write because the parent
// (ChatView header) does. Memo lets the component skip those re-renders since
// it has no props; only its own store selectors trigger work.
export default memo(ModelIndicator)
