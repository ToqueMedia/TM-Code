import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { COUNTRIES, DEFAULT_COUNTRY, type Country } from '@/services/auth/countries'

interface PhoneInputProps {
  /** Selected country (controlled) */
  country: Country
  onCountryChange: (country: Country) => void
  /** National-format phone digits (no dial code, no `+`) */
  number: string
  onNumberChange: (number: string) => void
  disabled?: boolean
  autoFocus?: boolean
}

/**
 * Compose the full E.164 number: `+{dialCode}{nationalNumber}` with all
 * non-digit characters stripped. The caller should use this value when
 * sending to Firebase `linkWithPhoneNumber`.
 */
export function toE164(country: Country, number: string): string {
  const digits = number.replace(/\D+/g, '')
  return `+${country.dialCode}${digits}`
}

function PhoneInput({
  country,
  onCountryChange,
  number,
  onNumberChange,
  disabled,
  autoFocus,
}: PhoneInputProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return COUNTRIES
    return COUNTRIES.filter(c =>
      c.name.toLowerCase().includes(q)
      || c.dialCode.includes(q)
      || c.code.toLowerCase().includes(q)
    )
  }, [query])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (open) {
      // Defer focus so the dropdown is mounted before we focus the search input
      requestAnimationFrame(() => searchRef.current?.focus())
    } else {
      setQuery('')
      setHighlight(0)
    }
  }, [open])

  useEffect(() => {
    setHighlight(0)
  }, [query])

  const select = useCallback((c: Country) => {
    onCountryChange(c)
    setOpen(false)
  }, [onCountryChange])

  const handleSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(h => Math.min(h + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const c = filtered[highlight]
      if (c) select(c)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <Box position="relative" ref={wrapperRef}>
      <Flex
        gap={2}
        align="stretch"
      >
        {/* Country selector trigger */}
        <button
          type="button"
          className="phone-country-btn"
          onClick={() => !disabled && setOpen(o => !o)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '0 12px',
            height: '40px',
            background: tokens.colors.bg.mainLayout,
            border: `1px solid ${tokens.colors.border.panel}`,
            borderRadius: '10px',
            color: tokens.colors.text.primary,
            fontSize: '13px',
            fontFamily: 'inherit',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            transition: `border-color ${tokens.transition.normal}`,
            minWidth: '110px',
            outline: 'none',
          }}
        >
          <span style={{ fontSize: '16px', lineHeight: 1 }}>{country.flag}</span>
          <span style={{ color: tokens.colors.text.secondary }}>+{country.dialCode}</span>
          <Box
            ml="auto"
            as="span"
            transition="transform 0.2s"
            transform={open ? 'rotate(180deg)' : 'none'}
            color={tokens.colors.text.muted}
            fontSize="10px"
            lineHeight="1"
          >
            ▼
          </Box>
        </button>

        {/* National number */}
        <input
          type="tel"
          inputMode="numeric"
          className="auth-input"
          value={number}
          onChange={(e) => onNumberChange(e.target.value.replace(/[^\d\s]/g, ''))}
          placeholder="900 000 000"
          autoComplete="tel-national"
          autoFocus={autoFocus}
          disabled={disabled}
          style={{
            flex: 1,
            padding: '10px 12px',
            background: tokens.colors.bg.mainLayout,
            border: `1px solid ${tokens.colors.border.panel}`,
            borderRadius: '10px',
            color: tokens.colors.text.primary,
            fontSize: '13px',
            fontFamily: 'inherit',
            outline: 'none',
            transition: `border-color ${tokens.transition.normal}`,
          }}
        />
      </Flex>

      {/* Dropdown */}
      {open && (
        <Box
          position="absolute"
          top="calc(100% + 6px)"
          left={0}
          right={0}
          zIndex={50}
          bg={tokens.colors.bg.panel}
          border={`1px solid ${tokens.colors.border.panel}`}
          borderRadius="10px"
          boxShadow="0 12px 32px rgba(0, 0, 0, 0.45)"
          overflow="hidden"
          style={{ backdropFilter: 'blur(12px)' }}
        >
          {/* Search */}
          <Box p={2} borderBottom={`1px solid ${tokens.colors.border.panel}`}>
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKey}
              placeholder="Procurar país..."
              style={{
                width: '100%',
                padding: '8px 10px',
                background: tokens.colors.bg.mainLayout,
                border: `1px solid ${tokens.colors.border.panel}`,
                borderRadius: '8px',
                color: tokens.colors.text.primary,
                fontSize: '12px',
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
          </Box>

          <Box ref={listRef} maxHeight="240px" overflowY="auto">
            {filtered.length === 0 ? (
              <Text fontSize="12px" color={tokens.colors.text.muted} textAlign="center" py={3}>
                Nenhum país encontrado
              </Text>
            ) : (
              filtered.map((c, idx) => {
                const selected = c.code === country.code && c.dialCode === country.dialCode
                const highlighted = idx === highlight
                return (
                  <button
                    type="button"
                    key={`${c.code}-${c.dialCode}`}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => select(c)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      width: '100%',
                      padding: '8px 12px',
                      background: highlighted
                        ? tokens.colors.bg.hoverSubtle
                        : 'transparent',
                      border: 'none',
                      color: tokens.colors.text.primary,
                      fontSize: '12px',
                      fontFamily: 'inherit',
                      textAlign: 'left',
                      cursor: 'pointer',
                      outline: 'none',
                      transition: 'background 0.1s',
                    }}
                  >
                    <span style={{ fontSize: '16px', lineHeight: 1 }}>{c.flag}</span>
                    <span style={{ flex: 1, color: tokens.colors.text.primary }}>{c.name}</span>
                    <span style={{ color: tokens.colors.text.secondary, fontVariantNumeric: 'tabular-nums' }}>
                      +{c.dialCode}
                    </span>
                    {selected && (
                      <span style={{ color: tokens.colors.accent.primary, fontSize: '11px' }}>✓</span>
                    )}
                  </button>
                )
              })
            )}
          </Box>
        </Box>
      )}
    </Box>
  )
}

export { DEFAULT_COUNTRY }
export default PhoneInput
