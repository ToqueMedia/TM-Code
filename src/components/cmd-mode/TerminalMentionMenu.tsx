import { memo, useEffect, useId, useRef } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import type { QuickOpenItem } from '../../services/quickOpenService'

interface TerminalMentionMenuProps {
  items: QuickOpenItem[]
  selectedIndex: number
  onSelect: (item: QuickOpenItem) => void
  projectPath: string
  query: string
  isBuilding: boolean
  /** Upper bound asked from the service. Used to render an "N+" hint when
   *  the result list is capped. */
  limit?: number
}

export const TerminalMentionMenu = memo(function TerminalMentionMenu({
  items,
  selectedIndex,
  onSelect,
  projectPath,
  query,
  isBuilding,
  limit,
}: TerminalMentionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const activeOptionId = items.length > 0 ? `${listboxId}-opt-${selectedIndex}` : undefined

  useEffect(() => {
    if (!menuRef.current) return
    const els = menuRef.current.querySelectorAll('[data-mention-item]')
    els[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const isEmpty = items.length === 0
  const isCapped = limit != null && items.length >= limit

  return (
    <Box
      ref={menuRef as React.RefObject<HTMLDivElement>}
      id={listboxId}
      role="listbox"
      aria-label="File and directory mentions"
      aria-activedescendant={activeOptionId}
      position="absolute"
      bottom="100%"
      left={0}
      right={0}
      mb="2px"
      bg={tokens.colors.terminal.background}
      border="1px solid rgba(163, 113, 247, 0.2)"
      borderBottom="none"
      overflow="auto"
      maxH="240px"
      zIndex={200}
      data-no-focus-steal
      onMouseDown={(e) => e.preventDefault()}
      css={{
        '&::-webkit-scrollbar': { width: '3px' },
        '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.1)', borderRadius: '2px' },
      }}
    >
      {/* Header / empty states */}
      {isEmpty ? (
        <Flex px={3} py="8px" align="center" gap={2}>
          {isBuilding ? (
            <>
              <Box
                w="6px"
                h="6px"
                borderRadius="full"
                bg={tokens.colors.accent.purple}
                css={{
                  animation: 'idxPulse 1.2s ease-in-out infinite',
                  '@keyframes idxPulse': { '0%, 100%': { opacity: 0.3 }, '50%': { opacity: 1 } },
                }}
              />
              <Text fontSize="11px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
                indexing project…
              </Text>
            </>
          ) : (
            <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
              {query ? `no match for "${query}"` : 'no files to mention'}
            </Text>
          )}
        </Flex>
      ) : (
        <>
        <Flex
          px={3}
          py="4px"
          justify="space-between"
          align="center"
          borderBottom="1px solid rgba(255,255,255,0.04)"
          bg="rgba(163,113,247,0.04)"
          position="sticky"
          top={0}
          zIndex={1}
        >
          <Text fontSize="9px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} letterSpacing="0.08em" textTransform="uppercase">
            {items.length}{isCapped ? '+' : ''} {items.length === 1 ? 'match' : 'matches'}
          </Text>
          <Text fontSize="9px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} letterSpacing="0.06em">
            ↑↓ navigate · ⏎ insert · esc close
          </Text>
        </Flex>
        {items.map((item, index) => {
          const normRoot = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
          const normPath = item.path.replace(/\\/g, '/')
          const relativePath = normPath.startsWith(normRoot + '/')
            ? normPath.slice(normRoot.length + 1)
            : normPath
          const isSelected = index === selectedIndex
          const isDir = !!item.isDirectory
          const glyph = isDir ? '▸' : '·'
          const glyphColor = isDir
            ? (isSelected ? tokens.colors.accent.orange : tokens.colors.accent.orange)
            : (isSelected ? tokens.colors.accent.purple : tokens.colors.text.disabled)

          return (
            <Flex
              key={item.path}
              id={`${listboxId}-opt-${index}`}
              role="option"
              aria-selected={isSelected}
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
                fontSize="11px"
                color={glyphColor}
                fontFamily={tokens.fontFamily.mono}
                fontWeight="700"
                flexShrink={0}
                userSelect="none"
                w="10px"
                textAlign="center"
                opacity={isDir ? 0.9 : 0.6}
              >
                {glyph}
              </Text>
              <Flex direction="column" gap={0} overflow="hidden" flex={1}>
                <Flex align="baseline" gap={1.5}>
                  <Text
                    fontSize="12px"
                    color={isSelected ? tokens.colors.terminal.foreground : tokens.colors.text.secondary}
                    fontFamily={tokens.fontFamily.mono}
                    fontWeight={isSelected ? '600' : '400'}
                    truncate
                  >
                    {item.name}{isDir ? '/' : ''}
                  </Text>
                  {isDir && (
                    <Text
                      fontSize="9px"
                      color={tokens.colors.accent.orange}
                      fontFamily={tokens.fontFamily.mono}
                      opacity={0.7}
                      textTransform="uppercase"
                      letterSpacing="0.06em"
                      flexShrink={0}
                    >
                      dir
                    </Text>
                  )}
                </Flex>
                <Text
                  fontSize="10px"
                  color={tokens.colors.text.disabled}
                  fontFamily={tokens.fontFamily.mono}
                  truncate
                >
                  {relativePath}{isDir ? '/' : ''}
                </Text>
              </Flex>
            </Flex>
          )
        })}
        </>
      )}
    </Box>
  )
})
