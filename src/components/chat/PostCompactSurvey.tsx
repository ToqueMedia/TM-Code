import { memo, useState, useCallback } from 'react'
import { Flex, Text, Button, HStack } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'

/**
 * Post-compact survey: appears 20% of the time after a compact boundary
 * is inserted. Shows a simple feedback prompt with 3 options.
 * Auto-hides after selection or after 30 seconds.
 */
function PostCompactSurvey() {
  const t = useTranslation()
  const [selected, setSelected] = useState<string | null>(null)
  const [visible, setVisible] = useState(true)
  const setPostCompactSurveyPending = useChatStore(s => s.setPostCompactSurveyPending)

  const handleSelect = useCallback((value: string) => {
    setSelected(value)
    // Log to console for now — analytics integration can be added later
    console.info('[post-compact-survey]', { response: value })
    // Close after a brief delay so the user sees their selection confirmed
    setTimeout(() => {
      setVisible(false)
      setPostCompactSurveyPending(false)
    }, 1500)
  }, [setPostCompactSurveyPending])

  // Auto-hide after 30 seconds
  useState(() => {
    const timer = setTimeout(() => {
      if (!selected) {
        setVisible(false)
        setPostCompactSurveyPending(false)
      }
    }, 30_000)
    return () => clearTimeout(timer)
  })

  if (!visible) return null

  const options = [
    { value: 'good', label: t('compactSurvey.good'), color: tokens.colors.accent.green },
    { value: 'ok', label: t('compactSurvey.ok'), color: tokens.colors.accent.orange },
    { value: 'bad', label: t('compactSurvey.bad'), color: tokens.colors.accent.red },
  ]

  return (
    <Flex
      align="center"
      gap={3}
      px={4}
      py={2}
      mx={4}
      mb={2}
      borderRadius="md"
      bg="rgba(255, 255, 255, 0.03)"
      border="1px solid rgba(255, 255, 255, 0.06)"
    >
      <Text fontSize="12px" color={tokens.colors.text.muted} whiteSpace="nowrap">
        {t('compactSurvey.howWasIt')}
      </Text>
      <HStack gap={2}>
        {selected ? (
          <Text fontSize="12px" color={tokens.colors.accent.green}>
            Obrigado!
          </Text>
        ) : (
          options.map(opt => (
            <Button
              key={opt.value}
              size="xs"
              variant="ghost"
              color={tokens.colors.text.muted}
              _hover={{ color: opt.color, bg: 'rgba(255,255,255,0.05)' }}
              onClick={() => handleSelect(opt.value)}
              transition="all 0.15s ease"
            >
              {opt.label}
            </Button>
          ))
        )}
      </HStack>
    </Flex>
  )
}

export default memo(PostCompactSurvey)
