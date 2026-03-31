import { useCallback } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import { useSettingsStore, type AppLanguage, type AgentLanguage } from '@/stores/settingsStore'
import OnboardingNav from '../OnboardingNav'

interface ConfigStepProps {
  onNext: () => void
  onBack: () => void
}

const MotionBox = motion.create(Box)

interface OptionCardProps {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
  compact?: boolean
}

function OptionCard({ selected, onClick, children, compact }: OptionCardProps) {
  const handleMouseEnter = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (!selected) {
      e.currentTarget.style.borderColor = tokens.colors.text.muted
      e.currentTarget.style.background = tokens.colors.bg.hoverSubtle
    }
  }, [selected])

  const handleMouseLeave = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.borderColor = selected ? tokens.colors.accent.primaryBorder : tokens.colors.border.panel
    e.currentTarget.style.background = selected ? tokens.colors.accent.primarySubtle : 'transparent'
  }, [selected])

  return (
    <button
      type="button"
      className="ob-option"
      onClick={onClick}
      style={{
        padding: compact ? '10px 12px' : '12px 16px',
        borderRadius: '10px',
        border: `1px solid ${selected ? tokens.colors.accent.primaryBorder : tokens.colors.border.panel}`,
        background: selected ? tokens.colors.accent.primarySubtle : 'transparent',
        cursor: 'pointer',
        textAlign: 'left' as const,
        width: compact ? 'auto' : '100%',
        fontFamily: 'inherit',
        color: tokens.colors.text.primary,
        transition: `all ${tokens.transition.normal}`,
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </button>
  )
}

const APP_LANGUAGES: { value: AppLanguage; label: string; flag: string }[] = [
  { value: 'pt', label: 'Português', flag: 'PT' },
  { value: 'en', label: 'English', flag: 'EN' },
]

const AGENT_LANGUAGES: { value: AgentLanguage; label: string }[] = [
  { value: 'pt', label: 'Português' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
]

function ConfigStep({ onNext, onBack }: ConfigStepProps) {
  const appLanguage = useSettingsStore(s => s.appLanguage)
  const agentLanguage = useSettingsStore(s => s.agentLanguage)
  const setAppLanguage = useSettingsStore(s => s.setAppLanguage)
  const setAgentLanguage = useSettingsStore(s => s.setAgentLanguage)
  const t = useTranslation()

  const handleAppLanguageChange = useCallback((lang: AppLanguage) => {
    // Read current values before updating — setAppLanguage is synchronous,
    // so reading after would return the new value already.
    const prevApp = useSettingsStore.getState().appLanguage
    const currentAgent = useSettingsStore.getState().agentLanguage
    setAppLanguage(lang)
    // Sync agent language only if it still matches the previous UI language
    // (i.e. user hasn't explicitly picked a different agent language yet).
    if (currentAgent === prevApp) {
      setAgentLanguage(lang)
    }
  }, [setAppLanguage, setAgentLanguage])

  return (
    <Flex direction="column" align="center" textAlign="center">
      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        mb={2}
      >
        <Text fontSize="24px" fontWeight="700" letterSpacing="-0.3px" lineHeight="1.3">
          {t('onboarding.config.title')}
        </Text>
      </MotionBox>

      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        mb={7}
      >
        <Text fontSize="13px" color={tokens.colors.text.secondary}>
          {t('onboarding.config.subtitle')}
        </Text>
      </MotionBox>

      {/* App Language */}
      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.25 }}
        width="100%"
        mb={5}
        textAlign="left"
      >
        <Text fontSize="12px" color={tokens.colors.text.secondary} mb={2} fontWeight="500">
          {t('onboarding.config.uiLanguage')}
        </Text>
        <Flex gap={2}>
          {APP_LANGUAGES.map(lang => (
            <OptionCard
              key={lang.value}
              selected={appLanguage === lang.value}
              onClick={() => handleAppLanguageChange(lang.value)}
            >
              <Flex align="center" gap={2.5}>
                <Box
                  width="28px"
                  height="20px"
                  borderRadius="3px"
                  bg={tokens.colors.bg.overlay}
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  fontSize="10px"
                  fontWeight="700"
                  color={tokens.colors.text.muted}
                  flexShrink={0}
                >
                  {lang.flag}
                </Box>
                <Text fontSize="13px" fontWeight="500">{lang.label}</Text>
              </Flex>
            </OptionCard>
          ))}
        </Flex>
      </MotionBox>

      {/* Agent Language */}
      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.35 }}
        width="100%"
        mb={8}
        textAlign="left"
      >
        <Text fontSize="12px" color={tokens.colors.text.secondary} mb={2} fontWeight="500">
          {t('onboarding.config.agentLanguage')}
        </Text>
        <Flex gap={2} flexWrap="wrap">
          {AGENT_LANGUAGES.map(lang => (
            <OptionCard
              key={lang.value}
              selected={agentLanguage === lang.value}
              onClick={() => setAgentLanguage(lang.value)}
              compact
            >
              <Text fontSize="12px" fontWeight="500">{lang.label}</Text>
            </OptionCard>
          ))}
        </Flex>
      </MotionBox>

      <OnboardingNav
        onBack={onBack}
        onNext={onNext}
        backLabel={t('onboarding.back')}
        nextLabel={t('onboarding.continue')}
        delay={0.45}
      />
    </Flex>
  )
}

export default ConfigStep
