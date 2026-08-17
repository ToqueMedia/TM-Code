import type { ReactNode } from 'react'
import { Box, Flex } from '@chakra-ui/react'
import { VscChevronDown, VscChevronRight } from 'react-icons/vsc'
import { tokens } from '@/theme/tokens'

/**
 * Alvo de expand compacto — só tão largo quanto o conteúdo.
 * A linha inteira NÃO é clicável: o resto do transcript fica livre.
 */
export function TranscriptToggle({
  expanded,
  onToggle,
  disabled,
  busy,
  children,
}: {
  expanded: boolean
  onToggle?: () => void
  disabled?: boolean
  busy?: boolean
  children: ReactNode
}) {
  const clickable = !disabled && !!onToggle
  return (
    <Flex
      as={clickable ? 'button' : 'div'}
      align="center"
      gap={2}
      w="fit-content"
      maxW="100%"
      minH="28px"
      px={2}
      py="5px"
      cursor={clickable ? 'pointer' : 'default'}
      bg="transparent"
      border="none"
      borderRadius="6px"
      textAlign="left"
      userSelect="none"
      _hover={clickable ? { bg: tokens.colors.bg.hoverSubtle } : undefined}
      _focusVisible={clickable ? { outline: `1px solid ${tokens.colors.border.focus}` } : undefined}
      onClick={clickable ? onToggle : undefined}
      aria-expanded={clickable ? expanded : undefined}
      aria-busy={busy || undefined}
    >
      {children}
      {clickable && (
        <Box color={tokens.colors.text.disabled} flexShrink={0}>
          {expanded ? <VscChevronDown size={13} /> : <VscChevronRight size={13} />}
        </Box>
      )}
    </Flex>
  )
}
