import { memo, useCallback, useEffect, useRef } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import type { SlashCommand } from '../../services/agent/slashCommandRegistry'

export type SlashCommandMenuTheme = 'red' | 'purple'

interface SlashCommandMenuProps {
  commands: SlashCommand[]
  selectedIndex: number
  onSelect: (command: SlashCommand) => void
  theme?: SlashCommandMenuTheme
  /** Open above the anchor ('up', default) or below ('down') */
  direction?: 'up' | 'down'
  /** Cap the menu height and scroll internally */
  maxHeight?: number
}

const THEME_COLORS: Record<SlashCommandMenuTheme, {
  selectionBg: string
  hoverBg: string
  boxShadow: string
  commandNameColor: string
}> = {
  red: {
    selectionBg: 'rgba(254, 16, 99, 0.1)',
    hoverBg: 'rgba(255, 255, 255, 0.04)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(254, 16, 99, 0.06)',
    commandNameColor: tokens.colors.accent.primary,
  },
  purple: {
    selectionBg: 'rgba(163, 113, 247, 0.1)',
    hoverBg: 'rgba(255, 255, 255, 0.04)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(163, 113, 247, 0.06)',
    commandNameColor: tokens.colors.accent.purple,
  },
}

function SlashCommandMenu({ commands, selectedIndex, onSelect, theme = 'red', direction = 'up', maxHeight }: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const colors = THEME_COLORS[theme]

  // Scroll selected item into view
  useEffect(() => {
    if (!menuRef.current) return
    const items = menuRef.current.querySelectorAll('[data-command-item]')
    const selected = items[selectedIndex]
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const handleClick = useCallback((cmd: SlashCommand) => {
    onSelect(cmd)
  }, [onSelect])

  if (commands.length === 0) return null

  return (
    <Box
      ref={menuRef}
      position="absolute"
      {...(direction === 'up'
        ? { bottom: '100%', mb: '6px' }
        : { top: '100%', mt: '6px' }
      )}
      left={0}
      right={0}
      bg="rgba(15, 15, 15, 0.95)"
      backdropFilter="blur(20px)"
      borderRadius="12px"
      border="1px solid rgba(255, 255, 255, 0.08)"
      boxShadow={colors.boxShadow}
      overflowY={maxHeight ? 'auto' : 'hidden'}
      maxH={maxHeight ? `${maxHeight}px` : undefined}
      zIndex={tokens.zIndex.dropdown}
      py="4px"
      css={maxHeight ? {
        '&::-webkit-scrollbar': { width: '3px' },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.1)', borderRadius: '2px' },
      } : undefined}
    >
      {commands.map((cmd, index) => (
        <Flex
          key={cmd.name}
          data-command-item
          px="14px"
          py="10px"
          mx="4px"
          borderRadius="8px"
          cursor={cmd.enabled ? 'pointer' : 'default'}
          align="center"
          gap={3}
          bg={index === selectedIndex ? colors.selectionBg : 'transparent'}
          transition="background 0.1s"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => cmd.enabled && handleClick(cmd)}
          _hover={cmd.enabled ? { bg: index === selectedIndex ? colors.selectionBg : colors.hoverBg } : undefined}
          opacity={cmd.enabled ? 1 : 0.45}
        >
          <Text
            fontFamily={tokens.fontFamily.mono}
            fontSize="13px"
            color={colors.commandNameColor}
            fontWeight="600"
            letterSpacing="-0.01em"
            flexShrink={0}
          >
            {cmd.name}
          </Text>
          <Text
            fontSize="12.5px"
            color={tokens.colors.text.secondary}
            letterSpacing="-0.005em"
            flex={1}
          >
            {cmd.description}
          </Text>
          {!cmd.enabled && (
            <Text
              fontSize="10px"
              color={tokens.colors.text.disabled}
              bg="rgba(255, 255, 255, 0.06)"
              px="6px"
              py="2px"
              borderRadius="4px"
              flexShrink={0}
              letterSpacing="0.02em"
            >
              coming soon
            </Text>
          )}
        </Flex>
      ))}
    </Box>
  )
}

export default memo(SlashCommandMenu)
