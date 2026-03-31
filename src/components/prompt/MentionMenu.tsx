import { memo, useEffect, useRef } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiFile } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import type { QuickOpenItem } from '../../services/quickOpenService'

interface MentionMenuProps {
  items: QuickOpenItem[]
  selectedIndex: number
  onSelect: (item: QuickOpenItem) => void
  projectPath: string
}

function MentionMenu({ items, selectedIndex, onSelect, projectPath }: MentionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuRef.current) return
    const els = menuRef.current.querySelectorAll('[data-mention-item]')
    const selected = els[selectedIndex]
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (items.length === 0) return null

  return (
    <Box
      ref={menuRef}
      position="absolute"
      bottom="100%"
      left={0}
      right={0}
      mb="6px"
      bg="rgba(15, 15, 15, 0.95)"
      backdropFilter="blur(20px)"
      borderRadius="12px"
      border="1px solid rgba(255, 255, 255, 0.08)"
      boxShadow="0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(254, 16, 99, 0.06)"
      overflow="auto"
      maxH="240px"
      zIndex={tokens.zIndex.dropdown}
      py="4px"
    >
      {items.map((item, index) => {
        const relativePath = item.path.startsWith(projectPath)
          ? item.path.slice(projectPath.length + 1)
          : item.path

        return (
          <Flex
            key={item.path}
            data-mention-item
            px="14px"
            py="8px"
            mx="4px"
            borderRadius="8px"
            cursor="pointer"
            align="center"
            gap={2.5}
            bg={index === selectedIndex ? 'rgba(254, 16, 99, 0.1)' : 'transparent'}
            transition="background 0.1s"
            onClick={() => onSelect(item)}
            _hover={{ bg: index === selectedIndex ? 'rgba(254, 16, 99, 0.1)' : 'rgba(255, 255, 255, 0.04)' }}
          >
            <FiFile size={14} color={tokens.colors.text.muted} style={{ flexShrink: 0 }} />
            <Flex direction="column" gap={0} overflow="hidden" flex={1}>
              <Text
                fontSize="13px"
                fontWeight="500"
                color={tokens.colors.text.primary}
                truncate
              >
                {item.name}
              </Text>
              <Text
                fontSize="11px"
                color={tokens.colors.text.disabled}
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
}

export default memo(MentionMenu)
