// src/components/ui/Toast.tsx — Toast notification overlay

import { useCallback } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useToastStore, type ToastType } from '@/stores/toastStore'

function getToastColors(type: ToastType) {
  switch (type) {
    case 'success':
      return {
        bg: tokens.colors.accent.greenSubtle,
        border: tokens.colors.accent.greenMuted,
        icon: tokens.colors.accent.greenBright,
        text: tokens.colors.accent.greenBright,
      }
    case 'warning':
      return {
        bg: 'rgba(240, 192, 0, 0.08)',
        border: 'rgba(240, 192, 0, 0.25)',
        icon: tokens.colors.status.warning,
        text: tokens.colors.status.warning,
      }
    case 'error':
      return {
        bg: tokens.colors.accent.redSubtle,
        border: tokens.colors.accent.redMuted,
        icon: tokens.colors.accent.red,
        text: tokens.colors.accent.red,
      }
    case 'info':
    default:
      return {
        bg: tokens.colors.accent.primarySubtle,
        border: tokens.colors.accent.primaryMuted,
        icon: tokens.colors.accent.primary,
        text: tokens.colors.accent.primary,
      }
  }
}

function getToastIcon(type: ToastType): string {
  switch (type) {
    case 'success':
      return '\u2713'
    case 'warning':
      return '!'
    case 'error':
      return '\u2717'
    case 'info':
    default:
      return 'i'
  }
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  const handleDismiss = useCallback(
    (id: string) => {
      removeToast(id)
    },
    [removeToast]
  )

  return (
    <Box
      position="fixed"
      bottom={tokens.spacing.lg}
      right={tokens.spacing.lg}
      zIndex={tokens.zIndex.toast}
      display="flex"
      flexDirection="column"
      gap={tokens.spacing.sm}
      pointerEvents="none"
      maxWidth="380px"
      maxHeight="50vh"
      overflowY="auto"
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          id={toast.id}
          type={toast.type}
          message={toast.message}
          onDismiss={handleDismiss}
        />
      ))}
    </Box>
  )
}

interface ToastItemProps {
  id: string
  type: ToastType
  message: string
  onDismiss: (id: string) => void
}

function ToastItem({ id, type, message, onDismiss }: ToastItemProps) {
  const colors = getToastColors(type)
  const icon = getToastIcon(type)

  return (
    <Flex
      role="alert"
      aria-live="assertive"
      alignItems="flex-start"
      gap={tokens.spacing.sm}
      padding={`${tokens.spacing.md} ${tokens.spacing.lg}`}
      bg={colors.bg}
      border={`1px solid ${colors.border}`}
      borderRadius={tokens.radius.lg}
      backdropFilter="blur(12px)"
      boxShadow={tokens.shadow.panel}
      pointerEvents="auto"
      css={{
        animation: 'toastSlideIn 0.2s ease-out',
        '@keyframes toastSlideIn': {
          from: { opacity: 0, transform: 'translateX(20px)' },
          to: { opacity: 1, transform: 'translateX(0)' },
        },
      }}
    >
      {/* Icon */}
      <Flex
        alignItems="center"
        justifyContent="center"
        minWidth="20px"
        height="20px"
        borderRadius={tokens.radius.full}
        bg={colors.border}
        color={colors.icon}
        fontSize={tokens.fontSize.xs}
        fontWeight="bold"
        fontFamily={tokens.fontFamily.mono}
        flexShrink={0}
        marginTop="1px"
      >
        {icon}
      </Flex>

      {/* Message */}
      <Text
        fontSize={tokens.fontSize.md}
        color={tokens.colors.text.primary}
        fontFamily={tokens.fontFamily.ui}
        lineHeight="1.4"
        flex="1"
      >
        {message}
      </Text>

      {/* Close button */}
      <Box
        as="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(id)}
        cursor="pointer"
        color={tokens.colors.text.muted}
        fontSize={tokens.fontSize.sm}
        lineHeight="1"
        padding="2px"
        borderRadius={tokens.radius.sm}
        flexShrink={0}
        marginTop="1px"
        _hover={{ color: tokens.colors.text.primary }}
        bg="transparent"
        border="none"
      >
        {'\u2715'}
      </Box>
    </Flex>
  )
}

export default ToastContainer
