import { useState, useCallback, useEffect, useRef } from 'react'
import { Box, Flex } from '@chakra-ui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tokens } from '@/theme/tokens'
import { useSettingsStore } from '@/stores/settingsStore'
import { useRequiredToolsStore } from '@/stores/requiredToolsStore'
import { getOSLanguage } from '@/i18n'
import { ONBOARDING_GLOBAL_STYLES } from './onboardingStyles'
import WindowControls from '../ui/WindowControls'
import { IS_MAC } from '@/utils/platform'
import WelcomeStep from './steps/WelcomeStep'
import ParadigmStep from './steps/ParadigmStep'
import ConfigStep from './steps/ConfigStep'
import ToolsStep from './steps/ToolsStep'
import FeaturesStep from './steps/FeaturesStep'
import ReadyStep from './steps/ReadyStep'

const TOTAL_STEPS = 6

interface OnboardingFlowProps {
  onComplete: () => void
}

const MotionBox = motion.create(Box)

const slideVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 400 : -400,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    x: direction > 0 ? -400 : 400,
    opacity: 0,
  }),
}

function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState(1)
  const stepRef = useRef(step)
  stepRef.current = step
  const completeOnboarding = useSettingsStore(s => s.completeOnboarding)
  const setAppLanguage = useSettingsStore(s => s.setAppLanguage)
  const setAgentLanguage = useSettingsStore(s => s.setAgentLanguage)

  // On first mount, set store language from OS locale so ConfigStep
  // shows the correct pre-selection and all text renders in the right language.
  useEffect(() => {
    const osLang = getOSLanguage()
    setAppLanguage(osLang)
    setAgentLanguage(osLang)
  }, [setAppLanguage, setAgentLanguage])

  const goNext = useCallback(() => {
    setDirection(1)
    setStep(s => Math.min(s + 1, TOTAL_STEPS - 1))
  }, [])

  const goBack = useCallback(() => {
    setDirection(-1)
    setStep(s => Math.max(s - 1, 0))
  }, [])

  const handleDone = useCallback(() => {
    completeOnboarding()
    // Re-detect required tools so the runtime send-gate reflects anything just
    // installed during onboarding (otherwise it'd stay blocked until refocus).
    useRequiredToolsStore.getState().refresh()
    onComplete()
  }, [completeOnboarding, onComplete])

  // Keyboard navigation — ArrowRight/ArrowLeft between steps, Escape to skip
  // Uses stepRef to always read the latest step value, preventing rapid keypresses
  // from pushing the index beyond the array bounds.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const s = stepRef.current
      if (e.key === 'ArrowRight' && s < TOTAL_STEPS - 1) {
        setDirection(1)
        setStep(s + 1)
      } else if (e.key === 'ArrowLeft' && s > 0) {
        setDirection(-1)
        setStep(s - 1)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  const handleDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.target as HTMLElement
    const tag = el.tagName?.toLowerCase() || ''
    if (['button', 'input', 'label', 'svg', 'path', 'a', 'select'].includes(tag)) return
    if (el.getAttribute?.('role') === 'button') return
    if (el.closest?.('[data-onboarding-interactive]')) return
    if (el.closest?.('.ob-option')) return
    getCurrentWindow().startDragging().catch(() => {})
  }, [])

  async function handleClose() {
    try { await getCurrentWindow().close() } catch { /* noop */ }
  }
  async function handleMinimize() {
    try { await getCurrentWindow().minimize() } catch { /* noop */ }
  }
  async function handleFullToggle() {
    try {
      const win = getCurrentWindow()
      if (/Mac/.test(navigator.platform || '')) {
        const fs = await win.isFullscreen()
        await win.setFullscreen(!fs)
      } else {
        const isMax = await win.isMaximized()
        if (isMax) await win.unmaximize()
        else await win.maximize()
      }
    } catch { /* noop */ }
  }

  const steps = [
    <WelcomeStep key="welcome" onNext={goNext} />,
    <ParadigmStep key="paradigm" onNext={goNext} onBack={goBack} />,
    <ConfigStep key="config" onNext={goNext} onBack={goBack} />,
    <ToolsStep key="tools" onNext={goNext} onBack={goBack} />,
    <FeaturesStep key="features" onNext={goNext} onBack={goBack} />,
    <ReadyStep key="ready" onDone={handleDone} onBack={goBack} />,
  ]

  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      height="100vh"
      bg={tokens.colors.bg.welcome}
      color={tokens.colors.text.primary}
      fontFamily={tokens.fontFamily.ui}
      position="relative"
      overflow="hidden"
      onMouseDown={handleDrag}
    >
      {/* Single global style tag for all onboarding CSS */}
      <style>{ONBOARDING_GLOBAL_STYLES}</style>

      {/* Window controls — macOS: top-left, Windows/Linux: top-right */}
      {IS_MAC ? (
        <Box position="absolute" top={3} left={4} zIndex={10}>
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        </Box>
      ) : (
        <Box position="absolute" top={0} right={0} zIndex={10}>
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        </Box>
      )}

      {/* Background gradient */}
      <Box
        position="fixed"
        top="0"
        left="0"
        width="100%"
        height="100%"
        zIndex="0"
        background={tokens.gradient.welcomeBg}
        pointerEvents="none"
      />

      {/* Step content */}
      <Box
        position="relative"
        zIndex={1}
        width="100%"
        maxWidth="520px"
        px={4}
        flex="1"
        display="flex"
        alignItems="center"
        justifyContent="center"
        overflow="auto"
        py={14}
      >
        <AnimatePresence mode="wait" custom={direction}>
          <MotionBox
            key={step}
            custom={direction}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            width="100%"
          >
            {steps[step]}
          </MotionBox>
        </AnimatePresence>
      </Box>

      {/* Progress dots */}
      <Flex
        position="absolute"
        bottom="28px"
        left="50%"
        transform="translateX(-50%)"
        zIndex={10}
        gap="8px"
        align="center"
      >
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
          <Box
            key={i}
            width={i === step ? '20px' : '6px'}
            height="6px"
            borderRadius="full"
            bg={i === step ? tokens.colors.accent.primary : tokens.colors.border.default}
            transition={`all ${tokens.transition.slow}`}
          />
        ))}
      </Flex>
    </Flex>
  )
}

export default OnboardingFlow
