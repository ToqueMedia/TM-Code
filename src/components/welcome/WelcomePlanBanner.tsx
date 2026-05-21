import { memo, useEffect, useState, useCallback, useRef } from 'react'
import { Box, Flex, HStack, Text, VStack } from '@chakra-ui/react'
import { FiZap, FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { getDeviceFingerprint } from '@/services/auth/deviceFingerprint'
import { useBillingStore, type MeResponse } from '@/stores/billingStore'
import { tauriFetch } from '@/services/tauriFetch'
import { resolveWorkerUrl } from '@/utils/devUrls'
import FirebaseAuthService, { getAppCheckHeader } from '@/services/auth/firebaseAuth'

const DISMISS_KEY = 'tm-welcome-plan-dismissed'
const EXPIRY_DATE = new Date('2026-05-28T23:59:59Z')

// Simulated MeResponse for when the backend endpoint is not yet deployed (404).
// Matches the Vibe plan structure so the billing store hydrates correctly.
const WELCOME_PLAN_RESPONSE: MeResponse = {
  plan: 'vibe',
  isActive: true,
  billing: {
    consumedPct: 0,
    tokensConsumed: 0,
    tokenBudget: 10_820_000, // Vibe: 10.82M
    cycleEnd: '2026-05-28',
    extraUsageBalance: 0,
    status: 'allowed',
  },
}

function isExpired(): boolean {
  return new Date() > EXPIRY_DATE
}

function isDismissed(): boolean {
  try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

function dismiss(): void {
  try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* ignore */ }
}

/** Minimal runtime guard — ensures the billing sub-object exists. */
function isValidMeResponse(data: unknown): data is MeResponse {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  if (typeof d.plan !== 'string') return false
  if (typeof d.isActive !== 'boolean') return false
  if (typeof d.billing !== 'object' || d.billing === null) return false
  const b = d.billing as Record<string, unknown>
  return (
    typeof b.consumedPct === 'number' &&
    typeof b.tokensConsumed === 'number' &&
    typeof b.tokenBudget === 'number' &&
    typeof b.cycleEnd === 'string' &&
    typeof b.status === 'string'
  )
}

function WelcomePlanBanner() {
  const [visible, setVisible] = useState(false)
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activated, setActivated] = useState(false)
  const plan = useBillingStore(s => s.plan)
  const isLoaded = useBillingStore(s => s.isLoaded)
  const updateFromMe = useBillingStore(s => s.updateFromMe)
  // Guard: once the banner has been shown, never re-show even if the plan
  // temporarily reverts to 'explorer' (e.g. from a stale /v1/me response
  // triggered by the Firestore onSnapshot listener after claimWelcomePlan).
  const hasShown = useRef(false)

  useEffect(() => {
    if (hasShown.current) return
    if (!isLoaded) return
    if (isExpired()) return
    if (isDismissed()) return
    if (plan !== 'explorer') return

    hasShown.current = true
    setVisible(true)
  }, [isLoaded, plan])

  const handleActivate = useCallback(async () => {
    setActivating(true)
    setError(null)

    try {
      const fingerprint = await getDeviceFingerprint()
      const authService = FirebaseAuthService.getInstance()
      const token = await authService.getIdToken()
      if (!token) {
        setError(t('welcomePlan.error'))
        setActivating(false)
        return
      }

      const appCheck = await getAppCheckHeader()
      const res = await tauriFetch(`${resolveWorkerUrl()}/v1/auth/activate-welcome-plan`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...appCheck,
        },
        body: JSON.stringify({ fingerprint }),
      })

      if (res.ok) {
        const data: unknown = await res.json()
        if (isValidMeResponse(data)) {
          updateFromMe(data)
        } else {
          updateFromMe(WELCOME_PLAN_RESPONSE)
        }
        authService.claimWelcomePlan(fingerprint)
        setActivated(true)
        setTimeout(() => setVisible(false), 1800)
      } else if (res.status === 404) {
        // Endpoint not yet deployed — activate locally + persist to Firestore
        updateFromMe(WELCOME_PLAN_RESPONSE)
        authService.claimWelcomePlan(fingerprint)
        setActivated(true)
        setTimeout(() => setVisible(false), 1800)
      } else if (res.status === 409) {
        // Already claimed on another account with this fingerprint
        setVisible(false)
      } else {
        setError(t('welcomePlan.error'))
      }
    } catch {
      setError(t('welcomePlan.error'))
    } finally {
      setActivating(false)
    }
  }, [updateFromMe])

  // Reserve vertical space even when hidden to prevent layout shift
  if (!visible) return <Box h="0" />

  return (
    <Box
      position="relative"
      w="100%"
      maxW="720px"
      mt={6}
      data-no-drag
      css={{
        animation: 'promoFadeIn 0.4s ease-out',
        '@keyframes promoFadeIn': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      }}
    >
      {/* Outer glow container */}
      <Box
        position="absolute"
        inset="-1px"
        borderRadius="16px"
        bg={`linear-gradient(135deg, ${tokens.colors.accent.primary}60, ${tokens.colors.accent.purple}40, ${tokens.colors.accent.primary}60)`}
        opacity={0.6}
        css={{ filter: 'blur(1px)' }}
      />

      {/* Card */}
      <Box
        position="relative"
        bg="rgba(15, 15, 15, 0.95)"
        backdropFilter="blur(20px)"
        borderRadius="16px"
        overflow="hidden"
      >
        {/* Top gradient line */}
        <Box
          h="2px"
          bg={`linear-gradient(90deg, transparent, ${tokens.colors.accent.primary}, ${tokens.colors.accent.purple}, transparent)`}
        />

        <Flex align="center" px={6} py={5} gap={5}>
          {/* Left: Mimo badge */}
          <Flex
            direction="column"
            align="center"
            gap="6px"
            flexShrink={0}
          >
            <Box
              w="48px"
              h="48px"
              borderRadius="14px"
              bg={`linear-gradient(135deg, ${tokens.colors.accent.primary}20, ${tokens.colors.accent.purple}20)`}
              border={`1px solid ${tokens.colors.accent.primary}30`}
              display="flex"
              alignItems="center"
              justifyContent="center"
              position="relative"
            >
              <Box
                position="absolute"
                inset="0"
                borderRadius="14px"
                bg={`radial-gradient(circle at 30% 30%, ${tokens.colors.accent.primary}15, transparent 70%)`}
              />
              <Text fontSize="20px" fontWeight="900" color={tokens.colors.accent.primary} position="relative">
                M
              </Text>
            </Box>
          </Flex>

          {/* Center: content */}
          <VStack align="stretch" gap="6px" flex={1} minW={0}>
            <HStack gap={2} align="center">
              <Text
                fontSize="14px"
                fontWeight="700"
                color={tokens.colors.text.primary}
                lineHeight="1.3"
                letterSpacing="-0.2px"
              >
                {t('welcomePlan.title')}
              </Text>
              <Box
                px="8px"
                py="2px"
                borderRadius="6px"
                bg={`${tokens.colors.accent.primary}18`}
                border={`1px solid ${tokens.colors.accent.primary}30`}
              >
                <Text
                  fontSize="9px"
                  fontWeight="700"
                  color={tokens.colors.accent.primary}
                  textTransform="uppercase"
                  letterSpacing="0.06em"
                >
                  {t('welcomePlan.badge')}
                </Text>
              </Box>
            </HStack>

            <Text fontSize="12px" color={tokens.colors.text.muted} lineHeight="1.5" maxW="400px">
              {t('welcomePlan.description')}
            </Text>

            {/* Feature pills */}
            <HStack gap={2} flexWrap="wrap">
              <FeatureTag text={t('welcomePlan.model')} />
              <FeatureTag text={t('welcomePlan.tokens')} />
              <FeatureTag text={t('welcomePlan.validUntil')} />
            </HStack>

            {error && (
              <Text fontSize="11px" color={tokens.colors.accent.red} lineHeight="1.4">
                {error}
              </Text>
            )}
          </VStack>

          {/* Right: CTA + dismiss */}
          <Flex direction="column" align="flex-end" gap={2} flexShrink={0}>
            <Box
              as="button"
              aria-label="Dismiss"
              display="flex"
              alignItems="center"
              justifyContent="center"
              w="20px"
              h="20px"
              borderRadius="4px"
              cursor="pointer"
              color={tokens.colors.text.disabled}
              _hover={{ bg: 'rgba(255,255,255,0.06)', color: tokens.colors.text.secondary }}
              transition={`all ${tokens.transition.fast}`}
              onClick={() => { dismiss(); setVisible(false) }}
            >
              <FiX size={10} />
            </Box>

            <Box
              as="button"
              display="flex"
              alignItems="center"
              justifyContent="center"
              gap="6px"
              px={5}
              py="10px"
              borderRadius="10px"
              bg={activated
                ? 'rgba(46, 160, 67, 0.15)'
                : `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.primaryDark})`
              }
              border={activated ? `1px solid ${tokens.colors.accent.green}30` : 'none'}
              color={activated ? tokens.colors.accent.green : '#fff'}
              fontSize="13px"
              fontWeight="600"
              letterSpacing="-0.1px"
              cursor={activating || activated ? 'default' : 'pointer'}
              opacity={activating ? 0.7 : 1}
              transition={`all ${tokens.transition.normal}`}
              _hover={activating || activated ? {} : {
                filter: 'brightness(1.12)',
                boxShadow: `0 6px 24px ${tokens.colors.accent.primary}35`,
                transform: 'translateY(-1px)',
              }}
              _active={activating || activated ? {} : { transform: 'translateY(0)' }}
              onClick={activating || activated ? undefined : handleActivate}
              whiteSpace="nowrap"
            >
              {activated ? (
                <>
                  <FiZap size={14} />
                  {t('welcomePlan.activated')}
                </>
              ) : activating ? (
                t('welcomePlan.activating')
              ) : (
                <>
                  <FiZap size={14} />
                  {t('welcomePlan.activate')}
                </>
              )}
            </Box>
          </Flex>
        </Flex>
      </Box>
    </Box>
  )
}

function FeatureTag({ text }: { text: string }) {
  return (
    <Flex
      align="center"
      px="10px"
      py="4px"
      borderRadius="8px"
      bg="rgba(255, 255, 255, 0.03)"
      border="1px solid rgba(255, 255, 255, 0.06)"
    >
      <Text
        fontSize="10px"
        fontWeight="500"
        color={tokens.colors.text.subtle}
        letterSpacing="0.01em"
      >
        {text}
      </Text>
    </Flex>
  )
}

export default memo(WelcomePlanBanner)
