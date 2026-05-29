import { memo, useEffect, useId, useRef } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

interface TerminalAutocompleteProps {
  completions: string[]
  selectedIndex: number
  position: { top: number; left: number }
  onSelect: (item: string) => void
}

export const TerminalAutocomplete = memo(function TerminalAutocomplete({
  completions,
  selectedIndex,
  position,
  onSelect,
}: TerminalAutocompleteProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const activeOptionId = completions.length > 0 ? `${listboxId}-opt-${selectedIndex}` : undefined

  useEffect(() => {
    if (!menuRef.current) return
    const els = menuRef.current.querySelectorAll('[data-ac-item]')
    els[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <Box
      ref={menuRef as React.RefObject<HTMLDivElement>}
      id={listboxId}
      role="listbox"
      aria-label="Terminal completions"
      aria-activedescendant={activeOptionId}
      position="absolute"
      top={`${position.top}px`}
      left={`${position.left}px`}
      minW="160px"
      maxW="320px"
      bg={tokens.colors.bg.panel}
      border={`1px solid ${tokens.colors.border.default}`}
      borderRadius={tokens.radius.md}
      overflow="auto"
      maxH="200px"
      zIndex={tokens.zIndex.dropdown}
      boxShadow={tokens.shadow.panel}
      data-no-focus-steal
      onMouseDown={(e) => e.preventDefault()}
      css={{
        '&::-webkit-scrollbar': { width: '3px' },
        '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.1)', borderRadius: '2px' },
      }}
    >
      {/* Header */}
      <Flex
        px={2}
        py="3px"
        justify="space-between"
        align="center"
        borderBottom="1px solid rgba(255,255,255,0.04)"
        bg="rgba(254,16,99,0.04)"
        position="sticky"
        top={0}
        zIndex={1}
      >
        <Text fontSize="9px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} letterSpacing="0.08em" textTransform="uppercase">
          {completions.length} completions
        </Text>
        <Text fontSize="9px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} letterSpacing="0.06em">
          tab confirm · esc close
        </Text>
      </Flex>

      {/* Items */}
      {completions.map((item, index) => {
        const isSelected = index === selectedIndex
        const isDir = item.endsWith('/')

        return (
          <Flex
            key={`${item}-${index}`}
            id={`${listboxId}-opt-${index}`}
            role="option"
            aria-selected={isSelected}
            data-ac-item
            data-no-focus-steal
            px={2}
            py="4px"
            align="center"
            gap={1.5}
            bg={isSelected ? 'rgba(254,16,99,0.12)' : 'transparent'}
            borderLeft={isSelected ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent'}
            cursor="pointer"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(item)}
            transition="background 0.08s"
            _hover={{ bg: isSelected ? 'rgba(254,16,99,0.12)' : 'rgba(255,255,255,0.04)' }}
          >
            <Text
              fontSize="11px"
              color={isDir ? tokens.colors.accent.orange : tokens.colors.text.disabled}
              fontFamily={tokens.fontFamily.mono}
              fontWeight="700"
              flexShrink={0}
              userSelect="none"
              w="10px"
              textAlign="center"
            >
              {isDir ? '/' : '.'}
            </Text>
            <Text
              fontSize="12px"
              color={isSelected ? tokens.colors.text.primary : tokens.colors.text.secondary}
              fontFamily={tokens.fontFamily.mono}
              fontWeight={isSelected ? '600' : '400'}
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {item}
            </Text>
          </Flex>
        )
      })}
    </Box>
  )
})
