import { Box, Button, Flex, HStack, Text, VStack } from '@chakra-ui/react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { CheckResult } from '../../services/environmentCheck'
import { tokens } from '@/theme/tokens'

interface RequirementsDialogProps {
  results: CheckResult[]
  onContinue: () => void
  onCancel: () => void
}

function StatusIcon({ result }: { result: CheckResult }) {
  if (result.found && result.meetsMinimum) {
    return (
      <Text fontSize="14px" color={tokens.colors.accent.greenBright} flexShrink={0}>
        ✓
      </Text>
    )
  }
  if (result.found && !result.meetsMinimum) {
    return (
      <Text fontSize="14px" color={tokens.colors.accent.orange} flexShrink={0}>
        !
      </Text>
    )
  }
  return (
    <Text fontSize="14px" color={tokens.colors.accent.red} flexShrink={0}>
      ✕
    </Text>
  )
}

function ResultRow({ result }: { result: CheckResult }) {
  const { requirement, found, version, meetsMinimum } = result

  let label: string
  let labelColor: string

  if (found && meetsMinimum) {
    label = `${requirement.name} v${version}`
    labelColor = tokens.colors.accent.greenBright
  } else if (found && !meetsMinimum) {
    label = `${requirement.name} v${version} — minimum required: ${requirement.minVersion}`
    labelColor = tokens.colors.accent.orange
  } else {
    label = `${requirement.name} — not found`
    labelColor = tokens.colors.accent.red
  }

  const showInstallInfo = !found || !meetsMinimum

  return (
    <VStack gap={1} alignItems="stretch">
      <HStack gap={2}>
        <StatusIcon result={result} />
        <Text fontSize="13px" fontWeight="500" color={labelColor}>
          {label}
        </Text>
      </HStack>

      {showInstallInfo && (
        <VStack gap={1} alignItems="stretch" pl="22px">
          <Text fontSize="11px" color={tokens.colors.text.muted}>
            {requirement.installHint}
          </Text>
          <Text
            fontSize="11px"
            color={tokens.colors.text.link}
            cursor="pointer"
            _hover={{ textDecoration: 'underline' }}
            onClick={() => openUrl(requirement.installUrl).catch(() => {})}
          >
            Open {requirement.installUrl}
          </Text>
        </VStack>
      )}
    </VStack>
  )
}

export function RequirementsDialog({ results, onContinue, onCancel }: RequirementsDialogProps) {
  const hasMissing = results.some(r => !r.found)
  const title = hasMissing ? 'Missing Requirements' : 'Version Warning'

  return (
    <Flex
      position="fixed"
      top={0}
      left={0}
      right={0}
      bottom={0}
      bg={tokens.colors.dialog.backdrop}
      zIndex={tokens.zIndex.overlay}
      alignItems="center"
      justifyContent="center"
      backdropFilter="blur(4px)"
    >
      <Box
        bg={tokens.colors.dialog.bg}
        border={`1px solid ${tokens.colors.dialog.border}`}
        borderRadius="12px"
        p={6}
        maxWidth="480px"
        width="90%"
        boxShadow={tokens.shadow.overlay}
      >
        {/* Title */}
        <Text fontSize="15px" fontWeight="600" color={tokens.colors.text.primary} mb={4}>
          {title}
        </Text>

        {/* Description */}
        <Text fontSize="12px" color={tokens.colors.text.muted} mb={4}>
          This template requires tools that were not found or are outdated on your system:
        </Text>

        {/* Results list */}
        <VStack gap={3} alignItems="stretch" mb={5}>
          {results.map((result) => (
            <ResultRow key={result.requirement.command} result={result} />
          ))}
        </VStack>

        {/* Warning message */}
        <Box
          bg={tokens.colors.bg.whiteSubtle}
          borderRadius="8px"
          p={3}
          mb={5}
        >
          <Text fontSize="11px" color={tokens.colors.text.muted} lineHeight="1.5">
            Without these tools, the project will not build or run.
            You can still scaffold the files and install the tools later.
          </Text>
        </Box>

        {/* Actions */}
        <HStack gap={3} justifyContent="flex-end">
          <Button
            variant="ghost"
            size="sm"
            color={tokens.colors.text.secondary}
            _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            bg={tokens.colors.accent.orange}
            color="white"
            _hover={{ opacity: 0.9 }}
            onClick={onContinue}
          >
            Continue anyway
          </Button>
        </HStack>
      </Box>
    </Flex>
  )
}
