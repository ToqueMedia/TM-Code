import { memo } from 'react'
import { Flex, Kbd, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import type { KeyBinding } from '@/stores/settingsStore'
import { IS_MAC } from '@/utils/platform'

const KEY_LABELS: Record<string, string> = {
  Enter: IS_MAC ? '↩' : 'Enter',
  Escape: 'Esc',
  Backquote: '`',
  Backslash: '\\',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
}

interface KeyBindingDisplayProps {
  binding: KeyBinding | null | undefined
  size?: 'sm' | 'md'
}

function KeyBindingDisplay({ binding, size = 'md' }: KeyBindingDisplayProps) {
  if (!binding) return <Text fontSize={size === 'sm' ? '10px' : '12px'} color={tokens.colors.text.disabled}>—</Text>

  const keys: string[] = []
  if (binding.meta) keys.push(IS_MAC ? '⌘' : 'Ctrl')
  if (binding.shift) keys.push(IS_MAC ? '⇧' : 'Shift')
  if (binding.alt) keys.push(IS_MAC ? '⌥' : 'Alt')
  keys.push(KEY_LABELS[binding.key] || binding.key.toUpperCase())

  const fontSize = size === 'sm' ? '10px' : '12px'
  const px = size === 'sm' ? 1.5 : 2

  return (
    <Flex gap={1} align="center">
      {keys.map((k, i) => (
        <Kbd
          key={i}
          fontSize={fontSize}
          fontWeight="600"
          color={tokens.colors.text.primary}
          bg="rgba(255, 255, 255, 0.08)"
          borderColor="rgba(255, 255, 255, 0.15)"
          borderWidth="1px"
          borderBottomWidth="2px"
          px={px}
          py={0}
          borderRadius="5px"
          lineHeight="1.5"
        >
          {k}
        </Kbd>
      ))}
    </Flex>
  )
}

export default memo(KeyBindingDisplay)
