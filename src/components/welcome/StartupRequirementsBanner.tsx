import { memo, useEffect, useState } from 'react'
import { Box, Flex, HStack, Text, VStack } from '@chakra-ui/react'
import { FiAlertTriangle, FiExternalLink, FiX, FiRefreshCw } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import {
  checkStartupRequirements,
  clearStartupRequirementsCache,
} from '@/services/startupRequirements'
import type { CheckResult } from '@/services/environmentCheck'

const SESSION_DISMISS_KEY = 'tm-startup-req-dismissed'

function isDismissed(): boolean {
  try { return sessionStorage.getItem(SESSION_DISMISS_KEY) === '1' } catch { return false }
}

function dismiss(): void {
  try { sessionStorage.setItem(SESSION_DISMISS_KEY, '1') } catch { /* ignore */ }
}

function StartupRequirementsBanner() {
  const [missing, setMissing] = useState<CheckResult[]>([])
  const [dismissed, setDismissed] = useState(isDismissed)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (dismissed) return
    let cancelled = false
    checkStartupRequirements().then(r => {
      if (cancelled) return
      const bad = r.results.filter(x => !x.found || !x.meetsMinimum)
      setMissing(bad)
    }).catch(() => { /* non-fatal */ })
    return () => { cancelled = true }
  }, [dismissed])

  const recheck = async () => {
    setLoading(true)
    clearStartupRequirementsCache()
    try {
      const r = await checkStartupRequirements(true)
      const bad = r.results.filter(x => !x.found || !x.meetsMinimum)
      setMissing(bad)
    } finally {
      setLoading(false)
    }
  }

  const openInstallUrl = async (url: string) => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
    } catch {
      window.open(url, '_blank')
    }
  }

  if (dismissed || missing.length === 0) return null

  return (
    <Box
      position="absolute"
      top="44px"
      left="50%"
      transform="translateX(-50%)"
      zIndex={5}
      maxW="640px"
      w="calc(100% - 48px)"
      bg="rgba(26, 26, 26, 0.92)"
      backdropFilter="blur(14px)"
      border={`1px solid ${tokens.colors.accent.orange}40`}
      borderRadius="12px"
      boxShadow="0 12px 40px rgba(0, 0, 0, 0.5)"
      px={4}
      py={3}
      data-no-drag
      css={{
        animation: 'slideDown 0.25s ease-out',
        '@keyframes slideDown': {
          from: { opacity: 0, transform: 'translate(-50%, -8px)' },
          to: { opacity: 1, transform: 'translate(-50%, 0)' },
        },
      }}
    >
      <Flex align="flex-start" gap={3}>
        <Box
          w="32px"
          h="32px"
          borderRadius="full"
          bg="rgba(247, 127, 0, 0.15)"
          display="flex"
          alignItems="center"
          justifyContent="center"
          flexShrink={0}
        >
          <FiAlertTriangle size={16} color={tokens.colors.accent.orange} />
        </Box>

        <VStack align="stretch" gap={2} flex={1} minW={0}>
          <Flex align="center" justify="space-between" gap={2}>
            <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
              {missing.length === 1
                ? 'A required tool is missing or outdated'
                : `${missing.length} required tools are missing or outdated`}
            </Text>
            <HStack gap={1}>
              <Box
                as="button"
                aria-label="Re-check"
                display="flex"
                alignItems="center"
                justifyContent="center"
                w="24px"
                h="24px"
                borderRadius="6px"
                cursor={loading ? 'default' : 'pointer'}
                opacity={loading ? 0.5 : 1}
                color={tokens.colors.text.disabled}
                _hover={loading ? {} : { bg: 'rgba(255,255,255,0.06)', color: tokens.colors.text.secondary }}
                onClick={() => { if (!loading) recheck() }}
              >
                <FiRefreshCw
                  size={12}
                  style={loading ? { animation: 'spin 0.7s linear infinite' } : undefined}
                />
              </Box>
              <Box
                as="button"
                aria-label="Dismiss"
                display="flex"
                alignItems="center"
                justifyContent="center"
                w="24px"
                h="24px"
                borderRadius="6px"
                cursor="pointer"
                color={tokens.colors.text.disabled}
                _hover={{ bg: 'rgba(255,255,255,0.06)', color: tokens.colors.text.secondary }}
                onClick={() => { dismiss(); setDismissed(true) }}
              >
                <FiX size={12} />
              </Box>
            </HStack>
          </Flex>

          <VStack align="stretch" gap={1}>
            {missing.map(r => (
              <Flex
                key={r.requirement.command}
                align="center"
                justify="space-between"
                gap={3}
                px={2}
                py="6px"
                borderRadius="6px"
                bg="rgba(255, 255, 255, 0.03)"
              >
                <Box minW={0} flex={1}>
                  <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary}>
                    {r.requirement.name}
                    {r.requirement.minVersion && (
                      <Text
                        as="span"
                        fontSize="11px"
                        fontWeight="400"
                        color={tokens.colors.text.disabled}
                        ml={1}
                      >
                        ≥ {r.requirement.minVersion}
                      </Text>
                    )}
                  </Text>
                  <Text fontSize="11px" color={tokens.colors.text.secondary} lineHeight="1.4" lineClamp={1}>
                    {!r.found
                      ? r.requirement.installHint
                      : `Found ${r.version ?? 'unknown'} — ${r.requirement.installHint}`}
                  </Text>
                </Box>
                <Box
                  as="button"
                  display="flex"
                  alignItems="center"
                  gap="4px"
                  px="10px"
                  py="5px"
                  borderRadius="6px"
                  bg="rgba(254, 16, 99, 0.12)"
                  border={`1px solid ${tokens.colors.accent.primary}40`}
                  color={tokens.colors.accent.primary}
                  fontSize="11px"
                  fontWeight="600"
                  cursor="pointer"
                  transition={`all ${tokens.transition.fast}`}
                  flexShrink={0}
                  _hover={{ bg: 'rgba(254, 16, 99, 0.2)', borderColor: tokens.colors.accent.primary }}
                  onClick={() => openInstallUrl(r.requirement.installUrl)}
                >
                  Install
                  <FiExternalLink size={10} />
                </Box>
              </Flex>
            ))}
          </VStack>
        </VStack>
      </Flex>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </Box>
  )
}

export default memo(StartupRequirementsBanner)
