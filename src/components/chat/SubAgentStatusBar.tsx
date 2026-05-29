/**
 * SubAgentStatusBar — compact indicator below PromptBar showing running
 * sub-agents with a cancel button. Only visible when sub-agents are active.
 */

import { memo, useCallback } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { useSubAgentStore } from '@/stores/subAgentStore'

const pulseCss = {
  animation: 'subAgentPulse 1.5s ease-in-out infinite',
  '@keyframes subAgentPulse': {
    '0%, 100%': { opacity: 1 },
    '50%': { opacity: 0.4 },
  },
}

function SubAgentStatusBar() {
  const runningCount = useSubAgentStore(s => {
    let count = 0
    for (const run of s.runs.values()) {
      if (run.status === 'running') count++
    }
    return count
  })

  const abortAll = useSubAgentStore(s => s.abortAll)

  const handleCancel = useCallback(() => {
    abortAll()
  }, [abortAll])

  if (runningCount === 0) return null

  const labelKey = runningCount === 1
    ? 'prompt.subAgents.running'
    : 'prompt.subAgents.running.plural'

  return (
    <Flex
      align="center"
      gap="8px"
      px={3}
      py={1}
      mt={1.5}
      borderRadius="6px"
      bg="rgba(255,255,255,0.02)"
      border="1px solid"
      borderColor="rgba(255,255,255,0.06)"
    >
      <Box
        w="6px"
        h="6px"
        borderRadius="full"
        bg={tokens.colors.accent.primary}
        css={pulseCss}
        flexShrink={0}
      />
      <Text fontSize="12px" color={tokens.colors.text.secondary} flex="1">
        {t(labelKey).replace('{count}', String(runningCount))}
      </Text>
      <Text
        as="button"
        fontSize="11px"
        color={tokens.colors.accent.primary}
        cursor="pointer"
        _hover={{ textDecoration: 'underline' }}
        onClick={handleCancel}
        bg="none"
        border="none"
        p={0}
      >
        {t('prompt.subAgents.cancel')}
      </Text>
    </Flex>
  )
}

export default memo(SubAgentStatusBar)
