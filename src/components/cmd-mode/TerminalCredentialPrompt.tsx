import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useChatStore } from '../../stores/chatStore'
import { useCredentialRequestStore } from '../../stores/credentialRequestStore'
import type { ChatMessageCard, CredentialFieldDescriptor } from '../../types/chat'

interface TerminalCredentialPromptProps {
  messageId: string
  card: ChatMessageCard
}

export const TerminalCredentialPrompt = memo(function TerminalCredentialPrompt({
  messageId,
  card,
}: TerminalCredentialPromptProps) {
  const { projectPath, status, requestId, serviceName, fields, submittedKeys } = card

  const fieldList = (fields ?? []) as CredentialFieldDescriptor[]
  const [values, setValues] = useState<Record<string, string>>({})
  const [focusIdx, setFocusIdx] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  const isValid = useMemo(() => {
    return fieldList.every((f) => !f.required || (values[f.id] ?? '').trim() !== '')
  }, [fieldList, values])

  // Focus the first input on mount
  useEffect(() => {
    const el = inputRefs.current[0]
    if (el) el.focus()
  }, [])

  // Auto-remove after submit/cancel
  useEffect(() => {
    if (status !== 'submitted' && status !== 'cancelled') return
    const timer = setTimeout(() => {
      useChatStore.getState().removeMessage(messageId)
    }, 2500)
    return () => clearTimeout(timer)
  }, [status, messageId])

  // Detect multi-line KEY=value paste
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData.getData('text')
      if (!text.includes('=') || !text.includes('\n')) return
      const parsed: Record<string, string> = {}
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const k = trimmed.slice(0, eq).trim()
        let v = trimmed.slice(eq + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        }
        parsed[k] = v
      }
      const matching = fieldList.filter((f) => parsed[f.id] !== undefined)
      if (matching.length === 0) return
      e.preventDefault()
      setValues((prev) => {
        const next = { ...prev }
        for (const f of matching) next[f.id] = parsed[f.id]
        return next
      })
    },
    [fieldList],
  )

  const handleSubmit = useCallback(async () => {
    if (!requestId || !isValid || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await useCredentialRequestStore.getState().submit(requestId, projectPath, values)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }, [requestId, isValid, submitting, projectPath, values])

  const handleCancel = useCallback(() => {
    if (!requestId) return
    useCredentialRequestStore.getState().cancel(requestId)
    useChatStore.getState().updateCardStatus(messageId, 'cancelled')
  }, [requestId, messageId])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSubmit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        const next = e.shiftKey
          ? (focusIdx - 1 + fieldList.length) % fieldList.length
          : (focusIdx + 1) % fieldList.length
        setFocusIdx(next)
        inputRefs.current[next]?.focus()
      }
    },
    [handleSubmit, handleCancel, focusIdx, fieldList.length],
  )

  // ── Submitted state ──
  if (status === 'submitted') {
    const keys = submittedKeys ?? []
    return (
      <Box mb={3} py="2px" pl="6px">
        <Flex align="center" gap={1.5}>
          <Text fontSize="12px" color={tokens.colors.terminal.green} fontFamily={tokens.fontFamily.mono} flexShrink={0}>
            ✓
          </Text>
          <Text fontSize="13px" color={tokens.colors.terminal.green} fontFamily={tokens.fontFamily.mono}>
            Saved {keys.length} {keys.length === 1 ? 'credential' : 'credentials'} to .env
            {serviceName ? ` for ${serviceName}` : ''}
          </Text>
        </Flex>
        {keys.length > 0 && (
          <Text fontSize="11px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} ml="16px" mt="2px">
            {keys.join(', ')}
          </Text>
        )}
      </Box>
    )
  }

  // ── Cancelled state ──
  if (status === 'cancelled') {
    return (
      <Box mb={3} py="2px" pl="6px">
        <Flex align="center" gap={1.5}>
          <Text fontSize="12px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} flexShrink={0}>
            ✗
          </Text>
          <Text fontSize="13px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
            Credential request cancelled{serviceName ? ` for ${serviceName}` : ''}.
          </Text>
        </Flex>
      </Box>
    )
  }

  // ── Active form ──
  return (
    <Box
      mb={3}
      borderLeft={`2px solid ${tokens.colors.accent.purple}`}
      pl={3}
      py={2}
    >
      {/* Header */}
      <Flex align="center" gap={2} mb={2}>
        <Text fontSize="11px" color={tokens.colors.accent.purple} fontFamily={tokens.fontFamily.mono} fontWeight="700" textTransform="uppercase" letterSpacing="0.06em">
          CREDENTIALS
        </Text>
        {serviceName && (
          <Text fontSize="11px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
            {serviceName}
          </Text>
        )}
      </Flex>

      <Text fontSize="12px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} mb={3} lineHeight="1.5">
        The agent needs credentials to continue. Values are written to .env — never to the chat.
      </Text>

      {/* Fields */}
      {fieldList.map((field, idx) => {
        const isPassword = field.type === 'password'
        return (
          <Box key={field.id} mb={2}>
            <Flex align="center" gap={2} mb="4px">
              <Text fontSize="11px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono} fontWeight="600" textTransform="uppercase">
                {field.label}
              </Text>
              {field.required && (
                <Text fontSize="10px" color={tokens.colors.accent.purple} fontFamily={tokens.fontFamily.mono}>
                  *
                </Text>
              )}
              {isPassword && (
                <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
                  (hidden)
                </Text>
              )}
            </Flex>
            <Box position="relative">
              <input
                ref={(el) => { inputRefs.current[idx] = el }}
                type={isPassword ? 'password' : 'text'}
                value={values[field.id] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                onPaste={handlePaste}
                onFocus={() => setFocusIdx(idx)}
                onKeyDown={handleKeyDown}
                placeholder={isPassword ? '••••••••' : `Enter ${field.label.toLowerCase()}`}
                style={{
                  width: '100%',
                  background: 'rgba(0, 0, 0, 0.3)',
                  border: `1px solid ${focusIdx === idx ? tokens.colors.accent.purple : 'rgba(255, 255, 255, 0.08)'}`,
                  borderRadius: tokens.radius.sm,
                  padding: '6px 10px',
                  fontSize: '13px',
                  fontFamily: isPassword ? tokens.fontFamily.mono : undefined,
                  color: tokens.colors.text.primary,
                  outline: 'none',
                  lineHeight: '1.5',
                }}
              />
            </Box>
            {field.helperText && (
              <Text fontSize="11px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} mt="4px" lineHeight="1.3">
                {field.helperText}
              </Text>
            )}
          </Box>
        )
      })}

      {error && (
        <Text fontSize="12px" color={tokens.colors.accent.red} fontFamily={tokens.fontFamily.mono} mt={2}>
          {error}
        </Text>
      )}

      {/* Key hints — Refined-terminal: bare bracketed keycaps, no filled pills. */}
      <Flex align="center" gap={3} mt={3} pt={2} borderTop={`1px solid rgba(255, 255, 255, 0.06)`}>
        <Flex align="center" gap={1}>
          <Text as="span" fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.terminal.foreground} fontWeight="600">
            [⌘↵]
          </Text>
          <Text fontSize="10px" color={tokens.colors.terminal.green} fontFamily={tokens.fontFamily.mono} opacity={0.8}>
            {submitting ? 'saving...' : 'save'}
          </Text>
        </Flex>
        <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
          ·
        </Text>
        <Flex align="center" gap={1}>
          <Text as="span" fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.terminal.foreground} fontWeight="600">
            [esc]
          </Text>
          <Text fontSize="10px" color={tokens.colors.accent.red} fontFamily={tokens.fontFamily.mono} opacity={0.8}>
            cancel
          </Text>
        </Flex>
        <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
          ·
        </Text>
        <Flex align="center" gap={1}>
          <Text as="span" fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.terminal.foreground} fontWeight="600">
            [tab]
          </Text>
          <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} opacity={0.8}>
            next field
          </Text>
        </Flex>
      </Flex>
    </Box>
  )
})
