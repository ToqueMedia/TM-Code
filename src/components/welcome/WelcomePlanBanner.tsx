import { memo, useEffect, useState, useCallback, useRef } from 'react'
import { Box, Flex, HStack, Text, VStack, SimpleGrid, Portal } from '@chakra-ui/react'
import { FiZap, FiCheck, FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { getDeviceFingerprint } from '@/services/auth/deviceFingerprint'
import { useBillingStore } from '@/stores/billingStore'
import { useAuthStore } from '@/stores/authStore'
import { tauriFetch } from '@/services/tauriFetch'
import { resolveWorkerUrl } from '@/utils/devUrls'
import FirebaseAuthService, { getAppCheckHeader, db, COLLECTIONS } from '@/services/auth/firebaseAuth'
import { doc, getDoc } from 'firebase/firestore'

const EXPIRY_DATE = new Date('2026-05-28T23:59:59Z')
const DISMISS_KEY = 'tm-welcome-plan-dismissed-v2'
const ACTIVATED_KEY = 'tm-welcome-plan-activated'



function isExpired(): boolean {
  return new Date() > EXPIRY_DATE
}

function isDismissed(): boolean {
  try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

function dismiss(): void {
  try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* ignore */ }
}

function WelcomePlanBanner() {
  const [visible, setVisible] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activated, setActivated] = useState(false)
  const plan = useBillingStore(s => s.plan)
  const isLoaded = useBillingStore(s => s.isLoaded)
  const hasShown = useRef(false)
  // Caches the Firestore claim check from useEffect to avoid a second
  // read in handleActivate (Bug 6). Values: null = not checked,
  // true = already claimed/expired, false = safe to activate.
  const claimedInFirestore = useRef<boolean | null>(null)

  useEffect(() => {
    // Synchronous guards run on EVERY effect trigger — they respond to
    // state changes (plan upgrade, expiry, dismiss) that can happen
    // after the banner is already visible.
    if (!isLoaded) return
    if (isExpired()) { setVisible(false); return }
    if (isDismissed()) { setVisible(false); return }
    if (plan !== 'explorer') { setVisible(false); return }
    try {
      if (sessionStorage.getItem(ACTIVATED_KEY) === '1') { setVisible(false); return }
    } catch { /* ignore */ }

    // hasShown only gates the async Firestore check — not the guards above.
    if (hasShown.current) return

    // Verify welcomePlanClaimed/welcomePlanExpired in Firestore — prevents
    // re-activation when userPlan was manually reset to 'explorer' in
    // Firestore without clearing the claim flag.
    hasShown.current = true  // Block re-entries before async resolves
    const checkFirestoreClaim = async () => {
      try {
        const user = useAuthStore.getState().user
        if (!user?.uid) return
        const snap = await getDoc(doc(db(), COLLECTIONS.USERS, user.uid))
        if (!snap.exists()) {
          claimedInFirestore.current = false
          setVisible(true)
          return
        }
        const data = snap.data() as Record<string, unknown>
        if (data.welcomePlanClaimed === true || data.welcomePlanExpired === true) {
          claimedInFirestore.current = true
          return
        }
        claimedInFirestore.current = false
      } catch {
        // Firestore read failed — fall through to showing (fail open)
        claimedInFirestore.current = false
      }
      setVisible(true)
    }
    checkFirestoreClaim()
  }, [isLoaded, plan])

  const requestClose = useCallback(() => {
    setShowConfirm(true)
  }, [])

  const confirmClose = useCallback(() => {
    dismiss()
    setShowConfirm(false)
    setVisible(false)
  }, [])

  const cancelClose = useCallback(() => {
    setShowConfirm(false)
  }, [])

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

      // Bug 5 fix: re-verify welcomePlanClaimed before ANY activation path.
      // The endpoint (200) may not check this flag; the useEffect cache
      // may be stale if the user acted in another window. Use the cached
      // result when available (Bug 6), falling back to a live read.
      if (claimedInFirestore.current === null) {
        // Cache miss — read Firestore now
        const user = useAuthStore.getState().user
        if (user?.uid) {
          const snap = await getDoc(doc(db(), COLLECTIONS.USERS, user.uid))
          if (snap.exists()) {
            const userData = snap.data() as Record<string, unknown>
            claimedInFirestore.current =
              userData.welcomePlanClaimed === true || userData.welcomePlanExpired === true
          }
        }
      }
      if (claimedInFirestore.current === true) {
        setVisible(false)
        return
      }

      // Unified activation flow — all paths write to Firestore first,
      // then re-sync from /v1/me. This ensures IDE/Web/Backend always
      // agree on the plan state. No optimistic local updates.
      const shouldActivate = res.ok || res.status === 404

      if (shouldActivate) {
        // 1. Write to Firestore
        await authService.claimWelcomePlan(fingerprint)
        claimedInFirestore.current = true

        // 2. Re-sync from authoritative backend (/v1/me reads Firestore)
        await authService.fetchBillingInfo()

        // 3. Confirm the backend agrees
        const confirmedPlan = useBillingStore.getState().plan
        if (confirmedPlan === 'welcome') {
          setActivated(true)
          try { sessionStorage.setItem(ACTIVATED_KEY, '1') } catch { /* ignore */ }
          setTimeout(() => setVisible(false), 1800)
        } else {
          // Backend still returns 'explorer' — Firestore propagation lag.
          // Keep the banner visible so the user can retry.
          setError(t('welcomePlan.error'))
        }
      } else if (res.status === 409) {
        setVisible(false)
      } else {
        setError(t('welcomePlan.error'))
      }
    } catch {
      setError(t('welcomePlan.error'))
    } finally {
      setActivating(false)
    }
  }, [])

  if (!visible) return null

  return (
    <Portal>
      {/* Backdrop */}
      <Box
        position="fixed"
        inset={0}
        bg="rgba(0, 0, 0, 0.55)"
        backdropFilter="blur(6px)"
        zIndex={1000}
        css={{
          animation: 'planOverlayIn 0.3s ease-out',
          '@keyframes planOverlayIn': {
            from: { opacity: '0' },
            to: { opacity: '1' },
          },
        }}
        onClick={requestClose}
      />

      {/* Floating card */}
      <Flex
        position="fixed"
        top="50%"
        left="50%"
        transform="translate(-50%, -50%)"
        zIndex={1001}
        direction="column"
        align="center"
        data-no-drag
        css={{
          animation: 'planCardIn 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
          '@keyframes planCardIn': {
            from: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.95)' },
            to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
          },
        }}
      >
        {/* Close button */}
        <Flex justify="flex-end" w="100%" maxW="680px" mb={2}>
          <Box
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="28px"
            h="28px"
            borderRadius="8px"
            cursor="pointer"
            bg="rgba(255, 255, 255, 0.06)"
            border="1px solid rgba(255, 255, 255, 0.08)"
            color={tokens.colors.text.secondary}
            _hover={{
              bg: 'rgba(255, 255, 255, 0.1)',
              color: tokens.colors.text.primary,
            }}
            transition={`all ${tokens.transition.fast}`}
            onClick={requestClose}
          >
            <FiX size={14} />
          </Box>
        </Flex>

        {/* Section label */}
        <Text
          fontSize="12px"
          fontWeight="600"
          color={tokens.colors.text.disabled}
          textTransform="uppercase"
          letterSpacing="0.08em"
          mb={4}
        >
          {t('welcomePlan.sectionLabel')}
        </Text>

        <SimpleGrid columns={{ base: 1, md: 2 }} gap={4} w="100%" maxW="680px">
          {/* Explorer — Free (active plan) */}
          <PlanCard
            name={t('welcomePlan.explorerName')}
            badge={t('welcomePlan.explorerBadge')}
            badgeColor={tokens.colors.accent.green}
            icon={FiCheck}
            description={t('welcomePlan.explorerDesc')}
            features={[
              t('welcomePlan.explorerFeature1'),
              t('welcomePlan.explorerFeature2'),
            ]}
            price={t('welcomePlan.free')}
            isActive={true}
            isCurrent={plan === 'explorer' && !activated}
            accentColor={tokens.colors.accent.green}
          />

          {/* Vibe — Promotional */}
          <PlanCard
            name={t('welcomePlan.vibName')}
            badge={t('welcomePlan.badge')}
            badgeColor={tokens.colors.accent.primary}
            icon={FiZap}
            description={t('welcomePlan.description')}
            features={[
              t('welcomePlan.model'),
              t('welcomePlan.tokens'),
              t('welcomePlan.validUntil'),
            ]}
            price={t('welcomePlan.free')}
            isActive={activated}
            isCurrent={false}
            isPromo={true}
            accentColor={tokens.colors.accent.primary}
            activating={activating}
            onActivate={handleActivate}
          />
        </SimpleGrid>

        {error && (
          <Text fontSize="11px" color={tokens.colors.accent.red} lineHeight="1.4" mt={3}>
            {error}
          </Text>
        )}
      </Flex>

      {/* Confirmation dialog */}
      {showConfirm && (
        <Portal>
          <Box
            position="fixed"
            inset={0}
            bg="rgba(0, 0, 0, 0.6)"
            zIndex={1002}
            onClick={cancelClose}
          />
          <Flex
            position="fixed"
            top="50%"
            left="50%"
            transform="translate(-50%, -50%)"
            zIndex={1003}
            direction="column"
            bg={tokens.colors.bg.overlay}
            backdropFilter="blur(24px)"
            border={`1px solid ${tokens.colors.border.glass}`}
            borderRadius="16px"
            p={6}
            maxW="380px"
            w="90%"
            gap={4}
            css={{
              animation: 'dialogIn 0.2s ease-out',
              '@keyframes dialogIn': {
                from: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.96)' },
                to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
              },
            }}
          >
            <Text fontSize="15px" fontWeight="700" color={tokens.colors.text.primary}>
              {t('welcomePlan.confirmTitle')}
            </Text>
            <Text fontSize="13px" color={tokens.colors.text.muted} lineHeight="1.6">
              {t('welcomePlan.confirmDesc')}
            </Text>
            <HStack gap={3} justify="flex-end">
              <Box
                as="button"
                px={4}
                py="8px"
                borderRadius="8px"
                fontSize="12px"
                fontWeight="500"
                color={tokens.colors.text.secondary}
                bg="rgba(255, 255, 255, 0.05)"
                border={`1px solid ${tokens.colors.border.glass}`}
                cursor="pointer"
                _hover={{ bg: 'rgba(255, 255, 255, 0.08)' }}
                transition={`all ${tokens.transition.fast}`}
                onClick={cancelClose}
              >
                {t('welcomePlan.confirmCancel')}
              </Box>
              <Box
                as="button"
                px={4}
                py="8px"
                borderRadius="8px"
                fontSize="12px"
                fontWeight="600"
                color="#fff"
                bg={`linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.primaryDark})`}
                cursor="pointer"
                _hover={{ filter: 'brightness(1.12)' }}
                transition={`all ${tokens.transition.fast}`}
                onClick={confirmClose}
              >
                {t('welcomePlan.confirmClose')}
              </Box>
            </HStack>
          </Flex>
        </Portal>
      )}
    </Portal>
  )
}

// ── Plan Card Component ──

interface PlanCardProps {
  name: string
  badge: string
  badgeColor: string
  icon: typeof FiZap
  description: string
  features: string[]
  price: string
  priceNote?: string
  isActive: boolean
  isCurrent: boolean
  isPromo?: boolean
  accentColor: string
  activating?: boolean
  onActivate?: () => void
}

function PlanCard({
  name,
  badge,
  badgeColor,
  icon: Icon,
  description,
  features,
  price,
  priceNote,
  isActive,
  isCurrent,
  isPromo,
  accentColor,
  activating,
  onActivate,
}: PlanCardProps) {
  return (
    <Box
      bg={isPromo ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.04)'}
      backdropFilter="blur(20px)"
      border="1px solid"
      borderColor={isCurrent ? `${accentColor}50` : isActive && !isCurrent ? `${tokens.colors.accent.green}40` : 'rgba(255, 255, 255, 0.08)'}
      borderRadius="20px"
      p={6}
      position="relative"
      overflow="hidden"
      cursor={isPromo && !isActive ? 'pointer' : 'default'}
      _hover={isPromo && !isActive ? {
        transform: 'translateY(-4px)',
        borderColor: `${accentColor}70`,
        bg: 'rgba(255, 255, 255, 0.09)',
        boxShadow: `0 20px 40px -12px ${accentColor}25`,
      } : isCurrent ? {
        borderColor: `${accentColor}60`,
      } : {}}
      transition="all 0.35s cubic-bezier(0.4, 0, 0.2, 1)"
      onClick={isPromo && !isActive && onActivate ? onActivate : undefined}
    >
      {/* Top gradient line */}
      <Box
        position="absolute"
        top="0"
        left="0"
        right="0"
        height="2px"
        background={`linear-gradient(90deg, transparent, ${accentColor}, transparent)`}
        opacity={0.7}
      />

      {/* Corner glow */}
      <Box
        position="absolute"
        top="-40px"
        right="-40px"
        width="120px"
        height="120px"
        bg={`radial-gradient(circle, ${accentColor}12 0%, transparent 70%)`}
        borderRadius="full"
        pointerEvents="none"
      />

      {/* Header: icon + badge */}
      <Flex align="center" gap={3} mb={4}>
        <Flex
          w="40px"
          h="40px"
          borderRadius="12px"
          align="center"
          justify="center"
          bg={`${accentColor}12`}
          border={`1px solid ${accentColor}25`}
          flexShrink={0}
        >
          <Icon size={18} color={accentColor} />
        </Flex>
        <VStack align="flex-start" gap={0} flex={1} minW={0}>
          <Text
            fontSize="15px"
            fontWeight="700"
            color={tokens.colors.text.primary}
            lineHeight="1.2"
          >
            {name}
          </Text>
          <HStack gap={2} align="center">
            <Box
              px="6px"
              py="1px"
              borderRadius="4px"
              bg={`${badgeColor}18`}
              border={`1px solid ${badgeColor}30`}
            >
              <Text
                fontSize="9px"
                fontWeight="700"
                color={badgeColor}
                textTransform="uppercase"
                letterSpacing="0.06em"
              >
                {badge}
              </Text>
            </Box>
            {isCurrent && (
              <Box
                px="6px"
                py="1px"
                borderRadius="4px"
                bg={`${tokens.colors.accent.green}15`}
                border={`1px solid ${tokens.colors.accent.green}25`}
              >
                <Text
                  fontSize="9px"
                  fontWeight="600"
                  color={tokens.colors.accent.green}
                  textTransform="uppercase"
                  letterSpacing="0.04em"
                >
                  {t('welcomePlan.current')}
                </Text>
              </Box>
            )}
          </HStack>
        </VStack>
      </Flex>

      {/* Description */}
      <Text
        fontSize="12px"
        color={tokens.colors.text.muted}
        lineHeight="1.5"
        mb={4}
        css={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {description}
      </Text>

      {/* Features */}
      <VStack align="stretch" gap={2} mb={5}>
        {features.map((feat, i) => (
          <HStack key={i} gap={2} align="center">
            <Box
              w="4px"
              h="4px"
              borderRadius="full"
              bg={accentColor}
              opacity={0.6}
              flexShrink={0}
            />
            <Text fontSize="11px" color={tokens.colors.text.subtle} lineHeight="1.4">
              {feat}
            </Text>
          </HStack>
        ))}
      </VStack>

      {/* Price + CTA */}
      <Flex align="center" justify="space-between" gap={3}>
        <VStack align="flex-start" gap={0}>
          <Text fontSize="18px" fontWeight="800" color={tokens.colors.text.primary}>
            {price}
          </Text>
          {priceNote && (
            <Text fontSize="10px" color={tokens.colors.text.disabled} lineHeight="1.3">
              {priceNote}
            </Text>
          )}
        </VStack>

        {isPromo && !isActive && (
          <Box
            display="flex"
            alignItems="center"
            justifyContent="center"
            gap="6px"
            px={5}
            py="9px"
            borderRadius="10px"
            bg={activating
              ? `${accentColor}30`
              : `linear-gradient(135deg, ${accentColor}, ${tokens.colors.accent.primaryDark})`
            }
            color="#fff"
            fontSize="12px"
            fontWeight="600"
            letterSpacing="-0.1px"
            cursor={activating ? 'default' : 'pointer'}
            opacity={activating ? 0.7 : 1}
            transition={`all ${tokens.transition.normal}`}
            _hover={activating ? {} : {
              filter: 'brightness(1.15)',
              boxShadow: `0 4px 16px ${accentColor}30`,
            }}
            whiteSpace="nowrap"
            onClick={(e) => { e.stopPropagation(); onActivate?.() }}
          >
            <FiZap size={13} />
            {activating ? t('welcomePlan.activating') : t('welcomePlan.activate')}
          </Box>
        )}

        {isActive && (
          <Flex
            align="center"
            gap="5px"
            px={4}
            py="8px"
            borderRadius="10px"
            bg={`${tokens.colors.accent.green}12`}
            border={`1px solid ${tokens.colors.accent.green}20`}
          >
            <FiCheck size={13} color={tokens.colors.accent.green} />
            <Text fontSize="12px" fontWeight="600" color={tokens.colors.accent.green}>
              {t('welcomePlan.activated')}
            </Text>
          </Flex>
        )}
      </Flex>
    </Box>
  )
}

export default memo(WelcomePlanBanner)
