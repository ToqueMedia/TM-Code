import { useMemo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import OnboardingNav from '../OnboardingNav'

interface FeaturesStepProps {
  onNext: () => void
  onBack: () => void
}

const MotionBox = motion.create(Box)

interface FeatureCardProps {
  icon: React.ReactNode
  title: string
  description: string
  gradient: string
  shadow: string
  delay: number
}

function FeatureCard({ icon, title, description, gradient, shadow, delay }: FeatureCardProps) {
  return (
    <MotionBox
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ delay }}
      p={4}
      borderRadius="12px"
      bg={tokens.colors.bg.glass}
      border={`1px solid ${tokens.colors.border.glass}`}
      backdropFilter="blur(12px)"
      cursor="default"
    >
      <Flex align="flex-start" gap={3}>
        <Box
          width="36px"
          height="36px"
          borderRadius="8px"
          background={gradient}
          display="flex"
          alignItems="center"
          justifyContent="center"
          flexShrink={0}
          boxShadow={shadow}
        >
          {icon}
        </Box>
        <Box>
          <Text fontSize="13px" fontWeight="600" mb={1}>
            {title}
          </Text>
          <Text fontSize="12px" color={tokens.colors.text.secondary} lineHeight="1.5">
            {description}
          </Text>
        </Box>
      </Flex>
    </MotionBox>
  )
}

const iconProps = { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: '#fff', strokeWidth: '2', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

interface FeatureDef {
  iconPath: React.ReactNode
  titleKey: TranslationKey
  descKey: TranslationKey
  gradient: string
  shadow: string
}

const FEATURE_DEFS: FeatureDef[] = [
  {
    iconPath: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    titleKey: 'onboarding.features.chat',
    descKey: 'onboarding.features.chatDesc',
    gradient: tokens.gradient.accentPrimary,
    shadow: tokens.shadow.cardIconAccent,
  },
  {
    iconPath: <><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></>,
    titleKey: 'onboarding.features.preview',
    descKey: 'onboarding.features.previewDesc',
    gradient: tokens.gradient.accentGreen,
    shadow: tokens.shadow.cardIconGreen,
  },
  {
    iconPath: <><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>,
    titleKey: 'onboarding.features.editor',
    descKey: 'onboarding.features.editorDesc',
    gradient: tokens.gradient.accentPurple,
    shadow: tokens.shadow.cardIconPurple,
  },
  {
    iconPath: <><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>,
    titleKey: 'onboarding.features.terminal',
    descKey: 'onboarding.features.terminalDesc',
    gradient: tokens.gradient.accentOrange,
    shadow: tokens.shadow.cardIconOrange,
  },
]

function FeaturesStep({ onNext, onBack }: FeaturesStepProps) {
  const t = useTranslation()

  const features = useMemo(() =>
    FEATURE_DEFS.map(f => ({
      icon: <svg {...iconProps}>{f.iconPath}</svg>,
      title: t(f.titleKey),
      description: t(f.descKey),
      gradient: f.gradient,
      shadow: f.shadow,
    })),
  [t])

  return (
    <Flex direction="column" align="center" textAlign="center">
      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        mb={2}
      >
        <Text fontSize="24px" fontWeight="700" letterSpacing="-0.3px" lineHeight="1.3">
          {t('onboarding.features.title')}
        </Text>
      </MotionBox>

      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.15 }}
        mb={6}
      >
        <Text fontSize="13px" color={tokens.colors.text.secondary}>
          {t('onboarding.features.subtitle')}
        </Text>
      </MotionBox>

      <Flex direction="column" gap={3} width="100%" mb={8}>
        {features.map((f, i) => (
          <FeatureCard
            key={i}
            icon={f.icon}
            title={f.title}
            description={f.description}
            gradient={f.gradient}
            shadow={f.shadow}
            delay={0.2 + i * 0.08}
          />
        ))}
      </Flex>

      <OnboardingNav
        onBack={onBack}
        onNext={onNext}
        backLabel={t('onboarding.back')}
        nextLabel={t('onboarding.continue')}
        delay={0.55}
      />
    </Flex>
  )
}

export default FeaturesStep
