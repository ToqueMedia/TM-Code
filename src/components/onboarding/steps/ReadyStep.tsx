import { useEffect } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import {
  primaryBtnStyle, primaryHoverEnter, primaryHoverLeave,
  secondaryBtnStyle, secondaryHoverEnter, secondaryHoverLeave,
} from '../onboardingStyles'
import type { OnboardingDoneAction } from '../OnboardingFlow'

interface ReadyStepProps {
  onDone: (action: OnboardingDoneAction) => void
  onBack: () => void
}

const MotionBox = motion.create(Box)

function CheckmarkAnimation() {
  return (
    <Box width="72px" height="72px" position="relative" mx="auto">
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
        <motion.circle
          cx="36"
          cy="36"
          r="32"
          stroke={tokens.colors.accent.primary}
          strokeWidth="2.5"
          fill="none"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.6, ease: 'easeInOut', delay: 0.2 }}
        />
        <motion.path
          d="M22 36L32 46L50 28"
          stroke={tokens.colors.accent.primary}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.4, ease: 'easeInOut', delay: 0.7 }}
        />
      </svg>
      <Box
        position="absolute"
        top="50%"
        left="50%"
        transform="translate(-50%, -50%)"
        width="100px"
        height="100px"
        borderRadius="full"
        background="radial-gradient(circle, rgba(254, 16, 99, 0.15) 0%, transparent 70%)"
        pointerEvents="none"
      />
    </Box>
  )
}

function ReadyStep({ onDone, onBack }: ReadyStepProps) {
  const t = useTranslation()

  // Ask the OS for notification permission at the commitment moment. The
  // user is at the end of onboarding, about to sign in/up — a system prompt
  // here reads as part of the setup. Asking later (when the agent first
  // wants to notify about a permission request) feels like an unrelated
  // pop-up. ensureNotificationPermission() is idempotent; revisiting this
  // step via Back/Next won't re-prompt.
  useEffect(() => {
    import('@/services/notificationService').then(({ ensureNotificationPermission }) => {
      ensureNotificationPermission().catch(() => { /* unsupported platform */ })
    })
  }, [])

  return (
    <Flex direction="column" align="center" textAlign="center">
      <MotionBox
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        mb={6}
      >
        <CheckmarkAnimation />
      </MotionBox>

      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.4 }}
        mb={2}
      >
        <Text fontSize="24px" fontWeight="700" letterSpacing="-0.3px" lineHeight="1.3">
          {t('onboarding.ready.title')}
        </Text>
      </MotionBox>

      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.5 }}
        mb={8}
      >
        <Text fontSize="13px" color={tokens.colors.text.secondary} lineHeight="1.6" maxWidth="320px">
          {t('onboarding.ready.subtitle')}
        </Text>
      </MotionBox>

      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.6 }}
        width="100%"
        maxWidth="280px"
        display="flex"
        flexDirection="column"
        alignItems="center"
        gap={3}
      >
        <button
          type="button"
          className="ob-ready-btn ob-ready-primary"
          onClick={() => onDone('signup')}
          style={{
            ...primaryBtnStyle,
            width: '100%',
            padding: '13px 0',
            fontSize: '14px',
          }}
          onMouseEnter={primaryHoverEnter}
          onMouseLeave={primaryHoverLeave}
        >
          {t('onboarding.ready.createAccount')}
        </button>

        <button
          type="button"
          className="ob-ready-btn"
          onClick={() => onDone('signin')}
          style={{ ...secondaryBtnStyle, width: '100%', padding: '13px 0', color: tokens.colors.text.primary }}
          onMouseEnter={secondaryHoverEnter}
          onMouseLeave={secondaryHoverLeave}
        >
          {t('onboarding.ready.haveAccount')}
        </button>
      </MotionBox>

      <MotionBox
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.7 }}
        mt={4}
      >
        <Text
          fontSize="12px"
          color={tokens.colors.text.muted}
          cursor="pointer"
          role="button"
          tabIndex={0}
          _hover={{ color: tokens.colors.text.secondary }}
          transition={`color ${tokens.transition.normal}`}
          onClick={onBack}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onBack() }}
        >
          {t('onboarding.back')}
        </Text>
      </MotionBox>

      <MotionBox
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
        mt={5}
      >
        <Text fontSize="11px" color={tokens.colors.text.muted} lineHeight="1.5" maxWidth="300px">
          {t('onboarding.ready.syncNote')}
        </Text>
      </MotionBox>
    </Flex>
  )
}

export default ReadyStep
