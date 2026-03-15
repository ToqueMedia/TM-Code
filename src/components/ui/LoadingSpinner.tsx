import { memo } from 'react'
import { Flex, Spinner, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

const sizeMap = {
  sm: 'sm',
  md: 'md',
  lg: 'lg',
} as const

const fontSizeMap = {
  sm: tokens.fontSize.xs,
  md: tokens.fontSize.sm,
  lg: tokens.fontSize.md,
} as const

interface LoadingSpinnerProps {
  /** Spinner size. Default: 'md' */
  size?: 'sm' | 'md' | 'lg'
  /** Optional label shown below the spinner. */
  label?: string
}

/** Minimal branded spinner with optional label text. */
const LoadingSpinner = memo(function LoadingSpinner({
  size = 'md',
  label,
}: LoadingSpinnerProps) {
  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      gap={2}
    >
      <Spinner
        size={sizeMap[size]}
        color={tokens.colors.accent.primary}
      />
      {label && (
        <Text
          fontSize={fontSizeMap[size]}
          color={tokens.colors.text.muted}
        >
          {label}
        </Text>
      )}
    </Flex>
  )
})

export { LoadingSpinner }
