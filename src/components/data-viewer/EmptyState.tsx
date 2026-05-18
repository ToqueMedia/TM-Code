import { Box, Flex, Text } from '@chakra-ui/react'
import { FiDatabase, FiAlertCircle } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

interface EmptyStateProps {
  title: string
  hint?: string
  variant?: 'empty' | 'error'
  /** Optional CTA button — when provided alongside `onAction`, renders a
   *  primary-styled button below the hint. Used by "Database not
   *  provisioned" to seed a chat prompt for `provision_database`. */
  actionLabel?: string
  onAction?: () => void
}

function EmptyState({ title, hint, variant = 'empty', actionLabel, onAction }: EmptyStateProps) {
  const isError = variant === 'error'
  const Icon = isError ? FiAlertCircle : FiDatabase
  const color = isError ? tokens.colors.accent.red : tokens.colors.text.muted

  return (
    <Flex direction="column" align="center" justify="center" flex="1" gap={3} px={8} textAlign="center">
      <Box color={color} opacity={0.6}>
        <Icon size={32} />
      </Box>
      <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
        {title}
      </Text>
      {hint && (
        <Text fontSize="12px" color={tokens.colors.text.secondary} maxW="360px" lineHeight="1.5">
          {hint}
        </Text>
      )}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          style={{
            marginTop: 8,
            padding: '8px 16px',
            borderRadius: tokens.radius.md,
            background: tokens.colors.accent.primary,
            border: 'none',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: tokens.transition.fast,
          }}
        >
          {actionLabel}
        </button>
      )}
    </Flex>
  )
}

export default EmptyState
