import { Box, Flex, Text } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import OnboardingNav from '../OnboardingNav'

interface WelcomeStepProps {
  onNext: () => void
}

const MotionBox = motion.create(Box)

function WelcomeStep({ onNext }: WelcomeStepProps) {
  const t = useTranslation()

  return (
    <Flex direction="column" align="center" textAlign="center">
      {/* Logo with glow animation */}
      <MotionBox
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20, delay: 0.1 }}
        mb={6}
      >
        <Box position="relative" display="inline-block">
          <Box
            position="absolute"
            top="50%"
            left="50%"
            transform="translate(-50%, -50%)"
            width="120px"
            height="120px"
            borderRadius="full"
            background="radial-gradient(circle, rgba(254, 16, 99, 0.2) 0%, transparent 70%)"
            pointerEvents="none"
          />
          <img
            src="/isologo.svg"
            alt="TM Code"
            width={64}
            height={64}
            style={{ display: 'block', position: 'relative', zIndex: 1 }}
          />
        </Box>
      </MotionBox>

      {/* Brand name */}
      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.25 }}
        mb={3}
      >
        <Text
          fontSize="13px"
          fontWeight="600"
          letterSpacing="2px"
          textTransform="uppercase"
          style={{
            background: tokens.gradient.logoTitle,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          TM Code
        </Text>
      </MotionBox>

      {/* Main title */}
      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.35 }}
        mb={3}
      >
        <Text
          fontSize="28px"
          fontWeight="700"
          letterSpacing="-0.5px"
          lineHeight="1.3"
          style={{
            background: tokens.gradient.heroTitle,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          {t('onboarding.welcome.tagline')}
        </Text>
      </MotionBox>

      {/* Subtitle */}
      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.45 }}
        mb={10}
      >
        <Text
          fontSize="14px"
          color={tokens.colors.text.secondary}
          lineHeight="1.6"
          maxWidth="340px"
        >
          {t('onboarding.welcome.subtitle')}
        </Text>
      </MotionBox>

      {/* CTA */}
      <OnboardingNav
        onNext={onNext}
        nextLabel={t('onboarding.getStarted')}
        delay={0.55}
      />
    </Flex>
  )
}

export default WelcomeStep
