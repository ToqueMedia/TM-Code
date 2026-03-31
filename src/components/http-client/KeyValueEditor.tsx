import { memo, useCallback, useState, useRef, useEffect } from 'react'
import { t } from '@/i18n'
import { Flex, Box, Input } from '@chakra-ui/react'
import { FiPlus, FiX } from 'react-icons/fi'
import type { KeyValuePair } from '../../stores/httpClientStore'
import { tokens } from '@/theme/tokens'

// ── Standard HTTP headers and their common values ──

const HTTP_HEADERS = [
  'Accept', 'Accept-Charset', 'Accept-Encoding', 'Accept-Language',
  'Authorization', 'Cache-Control', 'Connection', 'Content-Disposition',
  'Content-Encoding', 'Content-Language', 'Content-Length', 'Content-Type',
  'Cookie', 'Date', 'ETag', 'Expect', 'Forwarded', 'From', 'Host',
  'If-Match', 'If-Modified-Since', 'If-None-Match', 'If-Range',
  'If-Unmodified-Since', 'Origin', 'Pragma', 'Range', 'Referer',
  'Transfer-Encoding', 'User-Agent',
  'X-API-Key', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto',
  'X-Request-ID', 'X-Requested-With', 'X-Correlation-ID',
]

const HEADER_VALUES: Record<string, string[]> = {
  'Accept': ['application/json', 'text/html', 'text/plain', 'application/xml', '*/*', 'image/*'],
  'Accept-Encoding': ['gzip', 'deflate', 'br', 'gzip, deflate, br'],
  'Accept-Language': ['en-US', 'en', 'pt-BR', 'pt', 'es', 'fr', '*'],
  'Authorization': ['Bearer ', 'Basic ', 'Token '],
  'Cache-Control': ['no-cache', 'no-store', 'max-age=0', 'max-age=3600', 'must-revalidate', 'public', 'private'],
  'Connection': ['keep-alive', 'close'],
  'Content-Type': [
    'application/json', 'application/json; charset=utf-8',
    'application/x-www-form-urlencoded', 'multipart/form-data',
    'text/plain', 'text/html', 'text/xml', 'application/xml',
    'application/octet-stream', 'application/pdf',
  ],
  'Content-Encoding': ['gzip', 'deflate', 'br', 'identity'],
  'Origin': ['http://localhost:3000', 'http://localhost:5173'],
  'Pragma': ['no-cache'],
  'Transfer-Encoding': ['chunked', 'compress', 'deflate', 'gzip'],
  'X-Requested-With': ['XMLHttpRequest'],
}

// ── Types ──

interface KeyValueEditorProps {
  pairs: KeyValuePair[]
  onAdd: () => void
  onUpdate: (id: string, field: 'key' | 'value' | 'enabled', val: string | boolean) => void
  onRemove: (id: string) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  /** Enable header suggestions for key and value fields */
  withHeaderSuggestions?: boolean
}

const inputStyle = {
  bg: 'transparent',
  border: 'none',
  borderRadius: 0,
  color: tokens.colors.text.primary,
  fontSize: tokens.fontSize.sm,
  fontFamily: tokens.fontFamily.mono,
  px: '10px',
  py: '6px',
  h: 'auto',
  _placeholder: { color: tokens.colors.text.disabled },
  _focus: { outline: 'none', boxShadow: 'none' },
  _focusVisible: { outline: 'none', boxShadow: 'none' },
}

// ── SuggestionInput — input with dropdown suggestions ──

function SuggestionInput({
  value,
  onChange,
  suggestions,
  placeholder,
  opacity,
}: {
  value: string
  onChange: (val: string) => void
  suggestions?: string[]
  placeholder?: string
  opacity?: number
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const filtered = suggestions?.filter(s =>
    !value || s.toLowerCase().includes(value.toLowerCase())
  ).slice(0, 12) || []

  const showDropdown = isOpen && filtered.length > 0

  useEffect(() => {
    setSelectedIdx(-1)
  }, [value])

  // Calculate fixed position from input bounding rect — update on scroll/resize
  useEffect(() => {
    if (!showDropdown || !inputRef.current) {
      setDropdownPos(null)
      return
    }
    const updatePos = () => {
      const el = inputRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      setDropdownPos({ top: rect.bottom + 2, left: rect.left, width: rect.width })
    }
    updatePos()
    window.addEventListener('scroll', updatePos, true)
    window.addEventListener('resize', updatePos)
    return () => {
      window.removeEventListener('scroll', updatePos, true)
      window.removeEventListener('resize', updatePos)
    }
  }, [showDropdown])

  const selectItem = useCallback((item: string) => {
    onChange(item)
    setIsOpen(false)
    inputRef.current?.focus()
  }, [onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showDropdown) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault()
      selectItem(filtered[selectedIdx])
    } else if (e.key === 'Escape') {
      setIsOpen(false)
    }
  }, [showDropdown, filtered, selectedIdx, selectItem])

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (inputRef.current?.contains(target)) return
      if (dropdownRef.current?.contains(target)) return
      setIsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  return (
    <>
      <Input
        ref={inputRef as any}
        {...inputStyle}
        placeholder={placeholder}
        value={value}
        opacity={opacity}
        onChange={(e) => {
          onChange(e.target.value)
          setIsOpen(true)
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {showDropdown && dropdownPos && (
        <Box
          ref={dropdownRef}
          position="fixed"
          top={`${dropdownPos.top}px`}
          left={`${dropdownPos.left}px`}
          w={`${dropdownPos.width}px`}
          zIndex={tokens.zIndex.overlay}
          bg={tokens.colors.bg.overlay}
          border={`1px solid ${tokens.colors.border.panel}`}
          borderRadius="6px"
          py="2px"
          maxH="200px"
          overflowY="auto"
          boxShadow={tokens.shadow.overlay}
          css={{
            '&::-webkit-scrollbar': { width: '3px' },
            '&::-webkit-scrollbar-thumb': { background: tokens.colors.scrollbar.thumb, borderRadius: '2px' },
          }}
        >
          {filtered.map((item, i) => (
            <Flex
              key={item}
              px="10px"
              py="4px"
              fontSize={tokens.fontSize.xs}
              fontFamily="mono"
              color={tokens.colors.text.secondary}
              bg={i === selectedIdx ? tokens.colors.bg.hoverSubtle : 'transparent'}
              cursor="pointer"
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              transition={`background ${tokens.transition.fast}`}
              onClick={() => selectItem(item)}
            >
              <HighlightMatch text={item} query={value} />
            </Flex>
          ))}
        </Box>
      )}
    </>
  )
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return <>{text}</>

  return (
    <>
      {text.slice(0, idx)}
      <Box as="span" color={tokens.colors.accent.primary} fontWeight={600}>
        {text.slice(idx, idx + query.length)}
      </Box>
      {text.slice(idx + query.length)}
    </>
  )
}

// ── Main component ──

function KeyValueEditor({
  pairs,
  onAdd,
  onUpdate,
  onRemove,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  withHeaderSuggestions = false,
}: KeyValueEditorProps) {
  const handleCheckboxKeyDown = useCallback((e: React.KeyboardEvent, id: string, enabled: boolean) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      onUpdate(id, 'enabled', !enabled)
    }
  }, [onUpdate])

  return (
    <Flex direction="column" flex="1" overflow="hidden">
      {/* Header */}
      <Flex
        px={3}
        py="5px"
        borderBottom={`1px solid ${tokens.colors.border.glass}`}
        flexShrink={0}
      >
        <Box w="28px" flexShrink={0} />
        <Box
          flex="1"
          fontSize="10px"
          fontWeight={600}
          color={tokens.colors.text.disabled}
          textTransform="uppercase"
          letterSpacing="0.5px"
          px="10px"
        >
          {keyPlaceholder}
        </Box>
        <Box
          flex="1"
          fontSize="10px"
          fontWeight={600}
          color={tokens.colors.text.disabled}
          textTransform="uppercase"
          letterSpacing="0.5px"
          px="10px"
        >
          {valuePlaceholder}
        </Box>
        <Box w="28px" flexShrink={0} />
      </Flex>

      {/* Rows */}
      <Box flex="1" overflowY="auto" css={{
        '&::-webkit-scrollbar': { width: '3px' },
        '&::-webkit-scrollbar-thumb': { background: tokens.colors.scrollbar.thumb, borderRadius: '2px' },
      }}>
        {pairs.map((pair) => (
          <Flex
            key={pair.id}
            align="center"
            borderBottom={`1px solid ${tokens.colors.border.glass}`}
            _hover={{ bg: tokens.colors.bg.hoverSubtle }}
            transition={`background ${tokens.transition.fast}`}
          >
            {/* Checkbox */}
            <Flex
              w="28px"
              h="100%"
              align="center"
              justify="center"
              flexShrink={0}
              cursor="pointer"
              role="checkbox"
              aria-checked={pair.enabled}
              aria-label={pair.enabled ? 'Disable entry' : 'Enable entry'}
              tabIndex={0}
              onClick={() => onUpdate(pair.id, 'enabled', !pair.enabled)}
              onKeyDown={(e) => handleCheckboxKeyDown(e, pair.id, pair.enabled)}
            >
              <Box
                w="12px"
                h="12px"
                borderRadius="3px"
                border={`1.5px solid ${pair.enabled ? tokens.colors.accent.primary : tokens.colors.border.input}`}
                bg={pair.enabled ? tokens.colors.accent.primary : 'transparent'}
                transition={`all ${tokens.transition.fast}`}
                position="relative"
              >
                {pair.enabled && (
                  <Box
                    position="absolute"
                    top="1px"
                    left="3px"
                    w="4px"
                    h="7px"
                    borderRight="1.5px solid white"
                    borderBottom="1.5px solid white"
                    transform="rotate(45deg)"
                  />
                )}
              </Box>
            </Flex>

            {/* Key */}
            <Box flex="1" borderRight={`1px solid ${tokens.colors.border.glass}`} position="relative">
              {withHeaderSuggestions ? (
                <SuggestionInput
                  value={pair.key}
                  onChange={(v) => onUpdate(pair.id, 'key', v)}
                  suggestions={HTTP_HEADERS}
                  placeholder={keyPlaceholder}
                  opacity={pair.enabled ? 1 : 0.4}
                />
              ) : (
                <Input
                  {...inputStyle}
                  placeholder={keyPlaceholder}
                  value={pair.key}
                  opacity={pair.enabled ? 1 : 0.4}
                  onChange={(e) => onUpdate(pair.id, 'key', e.target.value)}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              )}
            </Box>

            {/* Value */}
            <Box flex="1" position="relative">
              {withHeaderSuggestions ? (
                <SuggestionInput
                  value={pair.value}
                  onChange={(v) => onUpdate(pair.id, 'value', v)}
                  suggestions={HEADER_VALUES[pair.key] || []}
                  placeholder={valuePlaceholder}
                  opacity={pair.enabled ? 1 : 0.4}
                />
              ) : (
                <Input
                  {...inputStyle}
                  placeholder={valuePlaceholder}
                  value={pair.value}
                  opacity={pair.enabled ? 1 : 0.4}
                  onChange={(e) => onUpdate(pair.id, 'value', e.target.value)}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              )}
            </Box>

            {/* Remove */}
            <Flex
              w="28px"
              align="center"
              justify="center"
              flexShrink={0}
              cursor="pointer"
              color={tokens.colors.text.disabled}
              _hover={{ color: tokens.colors.accent.red }}
              transition={`color ${tokens.transition.fast}`}
              onClick={() => onRemove(pair.id)}
              role="button"
              aria-label={t("misc.removeEntry")}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onRemove(pair.id)
                }
              }}
            >
              <FiX size={12} />
            </Flex>
          </Flex>
        ))}
      </Box>

      {/* Add button */}
      <Flex
        align="center"
        gap={1}
        px={3}
        py="6px"
        cursor="pointer"
        color={tokens.colors.text.disabled}
        fontSize={tokens.fontSize.xs}
        _hover={{ color: tokens.colors.accent.primary }}
        transition={`color ${tokens.transition.fast}`}
        onClick={onAdd}
        flexShrink={0}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onAdd()
          }
        }}
      >
        <FiPlus size={11} />
        Add
      </Flex>
    </Flex>
  )
}

export default memo(KeyValueEditor)
