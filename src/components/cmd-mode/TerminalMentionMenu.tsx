import { memo, useEffect, useRef } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import type { QuickOpenItem } from '../../services/quickOpenService'

interface TerminalMentionMenuProps {
  items: QuickOpenItem[]
  selectedIndex: number
  onSelect: (item: QuickOpenItem) => void
  projectPath: string
}

export const TerminalMentionMenu = memo(function TerminalMentionMenu({
  items,
  selectedIndex,
  onSelect,
  projectPath,
}: TerminalMentionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Keep selected item visible
  useEffect(() => {
    if (!menuRef.current) return
    const els = menuRef.current.querySelectorAll('[data-mention-item]')
    els[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (items.length === 0) return null

  return (
    <Box
      ref={menuRef as React.RefObject<HTMLDivElement>}
      position="absolute"
      bottom="100%"
      left={0}
      right={0}
      mb="2px"
      bg={tokens.colors.terminal.background}
      border="1px solid rgba(163, 113, 247, 0.2)"
      borderBottom="none"
      overflow="auto"
      maxH="200px"
      zIndex={200}
      css={{
        '&::-webkit-scrollbar': { width: '3px' },
        '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.1)', borderRadius: '2px' },
      }}
    >
      {items.map((item, index) => {
        const relativePath = item.path.startsWith(projectPath)
          ? item.path.slice(projectPath.length + 1)
          : item.path
        const isSelected = index === selectedIndex

        return (
          <Flex
            key={item.path}
            data-mention-item
            data-no-focus-steal
            px={3}
            py="5px"
            align="center"
            gap={2}
            bg={isSelected ? 'rgba(163,113,247,0.12)' : 'transparent'}
            borderLeft={isSelected ? `2px solid ${tokens.colors.accent.purple}` : '2px solid transparent'}
            cursor="pointer"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(item)}
            transition="background 0.08s"
          >
            <Text
              fontSize="10px"
              color={isSelected ? tokens.colors.accent.purple : tokens.colors.text.disabled}
              fontFamily={tokens.fontFamily.mono}
              flexShrink={0}
              userSelect="none"
            >
              @
            </Text>
            <Flex direction="column" gap={0} overflow="hidden" flex={1}>
              <Text
                fontSize="12px"
                color={isSelected ? tokens.colors.terminal.foreground : tokens.colors.text.secondary}
                fontFamily={tokens.fontFamily.mono}
                fontWeight={isSelected ? '600' : '400'}
                truncate
              >
                {item.name}
              </Text>
              <Text
                fontSize="10px"
                color={tokens.colors.text.disabled}
                fontFamily={tokens.fontFamily.mono}
                truncate
              >
                {relativePath}
              </Text>
            </Flex>
          </Flex>
        )
      })}
    </Box>
  )
})
