import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import type { SessionSummary } from '../../types/chat'

interface TerminalSessionPickerProps {
  items: SessionSummary[]
  activeSessionId: string | null
  onSelect: (session: SessionSummary) => void
  onClose: () => void
}

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  const diffMin = Math.floor(diffMs / 60_000)
  const diffH = Math.floor(diffMs / 3_600_000)
  const diffD = Math.floor(diffMs / 86_400_000)
  if (diffMin < 1) return t('terminalMode.picker.now')
  if (diffMin < 60) return t('terminalMode.picker.minutesAgo').replace('{n}', String(diffMin))
  if (diffH < 24) return t('terminalMode.picker.hoursAgo').replace('{n}', String(diffH))
  if (diffD === 1) return t('terminalMode.picker.yesterday')
  if (diffD < 7) return t('terminalMode.picker.daysAgo').replace('{n}', String(diffD))
  const d = new Date(ts)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Keyboard-driven picker for CMD-mode `/resume`. Arrow keys navigate,
 * Enter loads, Esc closes without exiting CMD Mode. Owns Escape in the
 * CmdModeView priority chain (registered via a `data-session-picker`
 * marker the outer handler checks).
 */
export const TerminalSessionPicker = memo(function TerminalSessionPicker({
  items,
  activeSessionId,
  onSelect,
  onClose,
}: TerminalSessionPickerProps) {
  const [index, setIndex] = useState(() => {
    const i = items.findIndex(s => s.id === activeSessionId)
    return i >= 0 ? i : 0
  })
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Focus the root on mount so keyboard events flow here, not the textarea.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  // Scroll the selected row into view as the user navigates.
  useEffect(() => {
    if (!listRef.current) return
    const rows = listRef.current.querySelectorAll('[data-picker-row]')
    rows[index]?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (items.length === 0) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault()
      setIndex(i => (i >= items.length - 1 ? 0 : i + 1))
      return
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault()
      setIndex(i => (i <= 0 ? items.length - 1 : i - 1))
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setIndex(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      setIndex(items.length - 1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const item = items[index]
      if (item) onSelect(item)
      return
    }
    // Numeric shortcuts 1..9 for quick jump.
    if (/^[1-9]$/.test(e.key)) {
      const n = parseInt(e.key, 10) - 1
      if (n < items.length) {
        e.preventDefault()
        const item = items[n]
        if (item) onSelect(item)
      }
    }
  }, [items, index, onSelect, onClose])

  return (
    <Box
      ref={rootRef as React.RefObject<HTMLDivElement>}
      data-session-picker
      data-no-focus-steal
      tabIndex={-1}
      role="dialog"
      aria-label="Pick a session to resume"
      onKeyDown={handleKeyDown}
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={500}
      bg="rgba(10, 10, 10, 0.82)"
      backdropFilter="blur(6px)"
      display="flex"
      justifyContent="center"
      alignItems="flex-start"
      pt="60px"
      outline="none"
    >
      <Box
        w="92%"
        maxW="720px"
        maxH="70vh"
        bg={tokens.colors.terminal.background}
        border="1px solid rgba(163, 113, 247, 0.25)"
        boxShadow="0 10px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(163, 113, 247, 0.08)"
        borderRadius="4px"
        overflow="hidden"
        display="flex"
        flexDirection="column"
      >
        {/* Header */}
        <Flex
          px={4}
          py={2}
          justify="space-between"
          align="center"
          borderBottom="1px solid rgba(255,255,255,0.06)"
          bg="rgba(163, 113, 247, 0.06)"
        >
          <Text
            fontSize="11px"
            color={tokens.colors.accent.purple}
            fontFamily={tokens.fontFamily.mono}
            fontWeight="600"
            letterSpacing="0.08em"
            textTransform="uppercase"
          >
            {t('terminalMode.picker.title')}
          </Text>
          <Text
            fontSize="10px"
            color={tokens.colors.text.disabled}
            fontFamily={tokens.fontFamily.mono}
            letterSpacing="0.04em"
          >
            {t('terminalMode.picker.hint')}
          </Text>
        </Flex>

        {/* Empty state */}
        {items.length === 0 ? (
          <Flex px={4} py={4} justify="center">
            <Text fontSize="12px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
              {t('terminalMode.picker.empty')}
            </Text>
          </Flex>
        ) : (
          <Box
            ref={listRef as React.RefObject<HTMLDivElement>}
            overflowY="auto"
            css={{
              '&::-webkit-scrollbar': { width: '4px' },
              '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.1)', borderRadius: '2px' },
            }}
          >
            {items.map((item, i) => {
              const isSelected = i === index
              const isActive = item.id === activeSessionId
              const n = String(i + 1).padStart(2, ' ')
              const name = item.name || t('terminalMode.picker.unnamed')
              return (
                <Flex
                  key={item.id}
                  data-picker-row
                  role="option"
                  aria-selected={isSelected}
                  px={4}
                  py="8px"
                  align="center"
                  gap={3}
                  cursor="pointer"
                  bg={isSelected ? 'rgba(163,113,247,0.14)' : 'transparent'}
                  borderLeft={isSelected ? `2px solid ${tokens.colors.accent.purple}` : '2px solid transparent'}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onSelect(item)}
                  onMouseEnter={() => setIndex(i)}
                  transition="background 0.08s"
                >
                  <Text
                    fontSize="10px"
                    color={isSelected ? tokens.colors.accent.purple : tokens.colors.text.disabled}
                    fontFamily={tokens.fontFamily.mono}
                    fontWeight="600"
                    flexShrink={0}
                    w="22px"
                  >
                    {n}
                  </Text>
                  <Flex direction="column" gap={0} flex={1} minW={0}>
                    <Flex align="baseline" gap={2}>
                      <Text
                        fontSize="12px"
                        color={isSelected ? tokens.colors.terminal.foreground : tokens.colors.text.secondary}
                        fontFamily={tokens.fontFamily.mono}
                        fontWeight={isSelected || isActive ? '600' : '400'}
                        truncate
                      >
                        {name}
                      </Text>
                      {isActive && (
                        <Text
                          fontSize="9px"
                          color={tokens.colors.accent.orange}
                          fontFamily={tokens.fontFamily.mono}
                          fontWeight="600"
                          letterSpacing="0.08em"
                          textTransform="uppercase"
                          flexShrink={0}
                        >
                          {t('terminalMode.picker.active')}
                        </Text>
                      )}
                    </Flex>
                    <Text
                      fontSize="10px"
                      color={tokens.colors.text.disabled}
                      fontFamily={tokens.fontFamily.mono}
                      truncate
                    >
                      {formatRelativeTime(item.updatedAt)} · {item.messageCount} {item.messageCount !== 1 ? t('terminalMode.picker.messages') : t('terminalMode.picker.message')}
                      {item.lastMessage ? ` · ${item.lastMessage.slice(0, 60)}` : ''}
                    </Text>
                  </Flex>
                </Flex>
              )
            })}
          </Box>
        )}
      </Box>
    </Box>
  )
})
