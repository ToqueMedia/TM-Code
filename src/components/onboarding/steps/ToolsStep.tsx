import { useState, useEffect, useCallback } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import { FiZap, FiHardDrive, FiShield } from 'react-icons/fi'
import { invoke } from '@tauri-apps/api/core'
import { detectSystemPackageManager } from '@/services/packageManagerDetector'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import OnboardingNav from '../OnboardingNav'

interface ToolsStepProps {
  onNext: () => void
  onBack: () => void
}

const MotionBox = motion.create(Box)

type PnpmStatus = 'checking' | 'available' | 'not-installed' | 'installing' | 'installed' | 'error'

const BENEFITS = [
  { icon: FiZap, key: 'benefit1' as const },
  { icon: FiHardDrive, key: 'benefit2' as const },
  { icon: FiShield, key: 'benefit3' as const },
]

function ToolsStep({ onNext, onBack }: ToolsStepProps) {
  const [pnpmStatus, setPnpmStatus] = useState<PnpmStatus>('checking')
  const [pnpmVersion, setPnpmVersion] = useState('')
  const t = useTranslation()

  // Detect pnpm on mount using the shared detector
  useEffect(() => {
    let cancelled = false

    async function detect() {
      try {
        const pm = await detectSystemPackageManager()
        if (cancelled) return

        if (pm === 'pnpm') {
          // Get version for display
          const result = await invoke<{
            stdout: string; exitCode: number; success: boolean; timedOut: boolean; stderr: string
          }>('execute_command', { command: 'pnpm --version', cwd: '/tmp', timeoutSecs: 5 })
          if (!cancelled && result.exitCode === 0) {
            setPnpmVersion(result.stdout.trim().split('\n')[0])
          }
          setPnpmStatus('available')
        } else {
          setPnpmStatus('not-installed')
        }
      } catch {
        if (!cancelled) setPnpmStatus('not-installed')
      }
    }

    detect()
    return () => { cancelled = true }
  }, [])

  const [errorHint, setErrorHint] = useState('')

  const handleInstall = useCallback(async () => {
    setPnpmStatus('installing')
    setErrorHint('')

    // Try corepack first (no sudo needed, built into Node 16.13+), then npm global
    const methods = [
      { cmd: 'corepack enable && corepack prepare pnpm@latest --activate', needsSudo: false },
      { cmd: 'npm install -g pnpm', needsSudo: true },
    ]

    let hint = 'npm install -g pnpm'

    for (const { cmd, needsSudo } of methods) {
      try {
        const result = await invoke<{
          stdout: string; stderr: string; exitCode: number; success: boolean; timedOut: boolean
        }>('execute_command', { command: cmd, cwd: '/tmp', timeoutSecs: 60 })

        if (result.success && result.exitCode === 0) {
          // Verify
          const check = await invoke<{
            stdout: string; exitCode: number; success: boolean; timedOut: boolean; stderr: string
          }>('execute_command', { command: 'pnpm --version', cwd: '/tmp', timeoutSecs: 5 })

          if (check.success && check.exitCode === 0) {
            setPnpmVersion(check.stdout.trim().split('\n')[0])
            setPnpmStatus('installed')
            return
          }
        }

        // Track permission errors for the hint
        if (needsSudo && result.stderr?.includes('EACCES')) {
          hint = 'sudo npm install -g pnpm'
        }
      } catch {
        // try next method
      }
    }

    setPnpmStatus('error')
    setErrorHint(hint)
  }, [])

  const isReady = pnpmStatus === 'available' || pnpmStatus === 'installed'
  const showInstallButton = pnpmStatus === 'not-installed' || pnpmStatus === 'error'

  return (
    <Flex direction="column" align="center" textAlign="center">
      {/* Title */}
      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        mb={2}
      >
        <Text fontSize="24px" fontWeight="700" letterSpacing="-0.3px" lineHeight="1.3">
          {t('onboarding.tools.title')}
        </Text>
      </MotionBox>

      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        mb={6}
      >
        <Text fontSize="13px" color={tokens.colors.text.secondary} maxW="400px">
          {t('onboarding.tools.subtitle')}
        </Text>
      </MotionBox>

      {/* Benefits */}
      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.25 }}
        width="100%"
        mb={6}
      >
        <Flex direction="column" gap={3}>
          {BENEFITS.map(({ icon: Icon, key }) => (
            <Flex
              key={key}
              align="center"
              gap={3}
              px={4}
              py={3}
              borderRadius="10px"
              bg="rgba(255, 255, 255, 0.02)"
              border={`1px solid ${tokens.colors.border.panel}`}
            >
              <Flex
                w="32px"
                h="32px"
                borderRadius="8px"
                bg={tokens.colors.accent.primarySubtle}
                align="center"
                justify="center"
                flexShrink={0}
              >
                <Icon size={15} color={tokens.colors.accent.primary} />
              </Flex>
              <Text fontSize="13px" fontWeight="500" textAlign="left">
                {t(`onboarding.tools.${key}`)}
              </Text>
            </Flex>
          ))}
        </Flex>
      </MotionBox>

      {/* Status + Action */}
      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.35 }}
        width="100%"
        mb={7}
      >
        <Flex
          direction="column"
          align="center"
          gap={3}
          px={4}
          py={4}
          borderRadius="12px"
          bg="rgba(255, 255, 255, 0.03)"
          border={`1px solid ${tokens.colors.border.panel}`}
        >
          {/* Status indicator */}
          <Flex align="center" gap={2}>
            {pnpmStatus === 'checking' && (
              <>
                <Box
                  w="8px" h="8px" borderRadius="full"
                  bg={tokens.colors.accent.orange}
                  css={{ animation: 'pulse 1.5s ease-in-out infinite', '@keyframes pulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.3 } } }}
                />
                <Text fontSize="12px" color={tokens.colors.text.muted}>pnpm...</Text>
              </>
            )}
            {isReady && (
              <>
                <Box w="8px" h="8px" borderRadius="full" bg={tokens.colors.accent.green} />
                <Text fontSize="12px" color={tokens.colors.accent.green} fontWeight="500">
                  pnpm {pnpmVersion} — {pnpmStatus === 'installed' ? t('onboarding.tools.installed') : t('onboarding.tools.detected')}
                </Text>
              </>
            )}
            {pnpmStatus === 'not-installed' && (
              <>
                <Box w="8px" h="8px" borderRadius="full" bg={tokens.colors.text.disabled} />
                <Text fontSize="12px" color={tokens.colors.text.muted}>
                  pnpm — {t('onboarding.tools.notInstalled')}
                </Text>
              </>
            )}
            {pnpmStatus === 'installing' && (
              <>
                <Box
                  w="8px" h="8px" borderRadius="full"
                  bg={tokens.colors.accent.primary}
                  css={{ animation: 'pulse 1s ease-in-out infinite', '@keyframes pulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.3 } } }}
                />
                <Text fontSize="12px" color={tokens.colors.text.secondary}>
                  {t('onboarding.tools.installing')}
                </Text>
              </>
            )}
            {pnpmStatus === 'error' && (
              <Flex direction="column" align="center" gap={1}>
                <Flex align="center" gap={2}>
                  <Box w="8px" h="8px" borderRadius="full" bg={tokens.colors.accent.red} />
                  <Text fontSize="12px" color={tokens.colors.accent.red}>
                    {t('onboarding.tools.notInstalled')}
                  </Text>
                </Flex>
                {errorHint && (
                  <Flex direction="column" align="center" gap={0.5}>
                    <Text fontSize="11px" color={tokens.colors.text.muted}>
                      {t('onboarding.tools.failedHint')}
                    </Text>
                    <Text fontSize="11px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
                      {errorHint}
                    </Text>
                  </Flex>
                )}
              </Flex>
            )}
          </Flex>

          {/* Install button */}
          {showInstallButton && (
            <button
              type="button"
              className="ob-option"
              onClick={handleInstall}
              style={{
                padding: '10px 24px',
                borderRadius: '10px',
                border: `1px solid ${tokens.colors.accent.primaryBorder}`,
                background: tokens.colors.accent.primarySubtle,
                cursor: 'pointer',
                fontFamily: 'inherit',
                color: tokens.colors.accent.primary,
                fontSize: '13px',
                fontWeight: 600,
                transition: `all ${tokens.transition.normal}`,
              }}
            >
              {t('onboarding.tools.install')}
            </button>
          )}
        </Flex>
      </MotionBox>

      <OnboardingNav
        onBack={onBack}
        onNext={onNext}
        backLabel={t('onboarding.back')}
        nextLabel={isReady ? t('onboarding.continue') : t('onboarding.tools.skip')}
        delay={0.45}
      />
    </Flex>
  )
}

export default ToolsStep
