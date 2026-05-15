import { memo, useCallback, useEffect, useRef } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import type { HashtagOption } from '../../services/agent/hashtagRegistry'

export type HashtagMenuTheme = 'red' | 'purple'

interface HashtagMenuProps {
  items: HashtagOption[]
  selectedIndex: number
  onSelect: (item: HashtagOption) => void
  theme?: HashtagMenuTheme
  direction?: 'up' | 'down'
  maxHeight?: number
  /**
   * Per-tag hint shown as a badge when the underlying scaffolding is already
   * applied to the current project. Map key is the full tag (e.g. `#auth-google`),
   * value is a short sentence recommending the natural-language fix phrasing
   * (e.g. "Já aplicado · escreve 'Corrige o login com Google' para fixar").
   * Items without an entry render normally.
   */
  appliedHints?: Map<string, string>
}

const THEME_COLORS: Record<HashtagMenuTheme, {
  selectionBg: string
  hoverBg: string
  boxShadow: string
  tagColor: string
}> = {
  red: {
    selectionBg: 'rgba(254, 16, 99, 0.1)',
    hoverBg: 'rgba(255, 255, 255, 0.04)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(254, 16, 99, 0.06)',
    tagColor: tokens.colors.accent.primary,
  },
  purple: {
    selectionBg: 'rgba(163, 113, 247, 0.1)',
    hoverBg: 'rgba(255, 255, 255, 0.04)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(163, 113, 247, 0.06)',
    tagColor: tokens.colors.accent.purple,
  },
}

/**
 * Closed-vocabulary hashtag autocomplete (e.g. `#auth-google`).
 *
 * Visually parallels SlashCommandMenu but takes `HashtagOption[]` directly
 * instead of synthesised `SlashCommand`-shaped items — no leaky shape, no
 * dead `execute` callbacks.
 */
function HashtagMenu({ items, selectedIndex, onSelect, theme = 'red', direction = 'up', maxHeight, appliedHints }: HashtagMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const colors = THEME_COLORS[theme]

  useEffect(() => {
    if (!menuRef.current) return
    const elements = menuRef.current.querySelectorAll('[data-hashtag-item]')
    const selected = elements[selectedIndex]
    if (selected) selected.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleClick = useCallback((item: HashtagOption) => {
    onSelect(item)
  }, [onSelect])

  if (items.length === 0) return null

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
    >
      {items.map((item, index) => {
        const appliedHint = appliedHints?.get(item.tag)
        const isApplied = !!appliedHint
        return (
          <Flex
            key={item.tag}
            data-hashtag-item
            px="14px"
            py="10px"
            mx="4px"
            borderRadius="8px"
            cursor="pointer"
            align="center"
            gap={3}
            bg={index === selectedIndex ? colors.selectionBg : 'transparent'}
            transition="background 0.1s"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleClick(item)}
            _hover={{ bg: index === selectedIndex ? colors.selectionBg : colors.hoverBg }}
            opacity={isApplied ? 0.55 : 1}
            title={appliedHint}
          >
            <Text
              fontFamily={tokens.fontFamily.mono}
              fontSize="13px"
              color={isApplied ? tokens.colors.text.muted : colors.tagColor}
              fontWeight="600"
              letterSpacing="-0.01em"
              flexShrink={0}
            >
              {item.tag}
            </Text>
            <Text
              fontSize="12.5px"
              color={tokens.colors.text.secondary}
              letterSpacing="-0.005em"
              flex={1}
            >
              {item.description}
            </Text>
            {isApplied && (
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
                {t('scaffold.badge.applied')}
              </Text>
            )}
          </Flex>
        )
      })}
    </Box>
  )
}

export default memo(HashtagMenu)
