import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'
import { FiCheck, FiEye, FiEyeOff, FiKey, FiShield, FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useChatStore } from '../../stores/chatStore'
import { useCredentialRequestStore } from '../../stores/credentialRequestStore'
import type { ChatMessageCard, CredentialFieldDescriptor } from '../../types/chat'

interface CredentialRequestCardProps {
  messageId: string
  card: ChatMessageCard
}

function CredentialRequestCard({ messageId, card }: CredentialRequestCardProps) {
  const { projectPath, status, requestId, serviceName, fields, submittedKeys } = card

  const fieldList = (fields ?? []) as CredentialFieldDescriptor[]
  const [values, setValues] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isValid = useMemo(() => {
    return fieldList.every((f) => !f.required || (values[f.id] ?? '').trim() !== '')
  }, [fieldList, values])

  const handleChange = useCallback((id: string, value: string) => {
    setValues((prev) => ({ ...prev, [id]: value }))
  }, [])

  // Detect a multi-line "KEY=value" paste and auto-fill matching fields. The
  // model often produces `OPENAI_API_KEY=sk-...\nOPENAI_ORG=org-...` and the
  // user will paste the whole block — better to spread it across fields than
  // to dump everything into the first input.
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
      // The tool execute() handler updates the card to 'submitted' on resolution,
      // so we don't need to flip status here.
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

  const toggleReveal = useCallback((id: string) => {
    setRevealed((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  // Auto-remove the card from the transcript shortly after the user has acted.
  // The tool result already carries the outcome ("Saved N credentials..." or
  // "User cancelled..."), so the model has full context — keeping the card
  // around just clutters the chat. Several cards in sequence stack at the end
  // of the transcript and displace the actual conversation flow (the agent's
  // ongoing work appears above them in scroll order). 2.5s gives the user
  // time to read the success/cancel state before it disappears.
  useEffect(() => {
    if (status !== 'submitted' && status !== 'cancelled') return
    const timer = setTimeout(() => {
      useChatStore.getState().removeMessage(messageId)
    }, 2500)
    return () => clearTimeout(timer)
  }, [status, messageId])

  if (status === 'submitted') {
    const keys = submittedKeys ?? []
    return (
      <Box
        bg={tokens.colors.accent.greenSubtle}
        border={`1px solid ${tokens.colors.accent.greenMuted}`}
        borderRadius="12px"
        p={4}
        my={2}
      >
        <Flex align="center" gap={2}>
          <Flex
            w="24px"
            h="24px"
            borderRadius="6px"
            bg="rgba(46, 160, 67, 0.18)"
            align="center"
            justify="center"
            flexShrink={0}
          >
            <FiCheck size={12} color={tokens.colors.accent.greenBright} />
          </Flex>
          <Text fontSize="13px" color={tokens.colors.text.primary} fontWeight="500">
            Saved {keys.length} {keys.length === 1 ? 'credential' : 'credentials'} to <code>.env</code>
            {serviceName ? ` for ${serviceName}` : ''}
          </Text>
        </Flex>
        {keys.length > 0 && (
          <Text
            fontSize="11.5px"
            color={tokens.colors.text.muted}
            mt="6px"
            ml="32px"
            fontFamily="mono"
            letterSpacing="0.02em"
          >
            {keys.join(', ')}
          </Text>
        )}
      </Box>
    )
  }

  if (status === 'cancelled') {
    return (
      <Box
        bg="rgba(255, 255, 255, 0.03)"
        border="1px solid rgba(255, 255, 255, 0.08)"
        borderRadius="12px"
        p={4}
        my={2}
      >
        <Flex align="center" gap={2}>
          <FiX size={14} color={tokens.colors.text.muted} />
          <Text fontSize="13px" color={tokens.colors.text.muted}>
            Credential request cancelled{serviceName ? ` for ${serviceName}` : ''}.
          </Text>
        </Flex>
      </Box>
    )
  }

  return (
    <Box
      bg="rgba(255, 255, 255, 0.03)"
      border="1px solid rgba(255, 255, 255, 0.08)"
      borderTop={`3px solid ${tokens.colors.accent.primary}`}
      borderRadius="12px"
      overflow="hidden"
      my={2}
      boxShadow={`0 8px 24px -12px ${tokens.colors.accent.primaryGlow}`}
    >
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={4}
        py={3}
        bg="rgba(255, 255, 255, 0.02)"
        borderBottom="1px solid rgba(255, 255, 255, 0.06)"
      >
        <Flex align="center" gap={2}>
          <Flex
            w="26px"
            h="26px"
            borderRadius="7px"
            bg={tokens.colors.accent.primarySubtle}
            align="center"
            justify="center"
            color={tokens.colors.accent.primary}
            flexShrink={0}
          >
            <FiShield size={13} />
          </Flex>
          <Box>
            <Text
              fontSize="13px"
              fontWeight="600"
              color={tokens.colors.text.primary}
              lineHeight="1.2"
            >
              Credentials
            </Text>
            <Text
              fontSize="11.5px"
              color={tokens.colors.text.muted}
              lineHeight="1.2"
              mt="2px"
            >
              {serviceName ?? 'External service'}
            </Text>
          </Box>
        </Flex>
        <Text
          fontSize="10px"
          color={tokens.colors.text.muted}
          textTransform="uppercase"
          letterSpacing="0.08em"
          fontWeight="500"
          px={2}
          py="3px"
          borderRadius="4px"
          bg="rgba(255, 255, 255, 0.04)"
          border="1px solid rgba(255, 255, 255, 0.06)"
        >
          Secure
        </Text>
      </Flex>

      {/* Fields */}
      <Box px={4} py={4}>
        <Text fontSize="12px" color={tokens.colors.text.secondary} mb={4} lineHeight="1.5">
          The agent needs the following values to continue. They will be written
          directly to <code>.env</code> in your project — never to the chat.
        </Text>

        <Flex direction="column" gap={4}>
          {fieldList.map((field) => {
            const isPassword = field.type === 'password'
            const reveal = revealed[field.id]
            return (
              <Box key={field.id}>
                <Flex justify="space-between" align="center" mb="6px">
                  <Text
                    fontSize="11px"
                    color={tokens.colors.text.secondary}
                    fontWeight="600"
                    textTransform="uppercase"
                    letterSpacing="0.04em"
                  >
                    {field.label}
                    {field.required && (
                      <Text as="span" color={tokens.colors.accent.primary} ml="3px">
                        *
                      </Text>
                    )}
                  </Text>
                  {isPassword && (
                    <FiKey size={11} color={tokens.colors.text.muted} />
                  )}
                </Flex>
                <Box position="relative">
                  <Input
                    type={isPassword && !reveal ? 'password' : 'text'}
                    value={values[field.id] ?? ''}
                    onChange={(e) => handleChange(field.id, e.target.value)}
                    onPaste={handlePaste}
                    placeholder={isPassword ? '••••••••' : `Enter ${field.label.toLowerCase()}`}
                    bg="rgba(0, 0, 0, 0.3)"
                    border="1px solid rgba(255, 255, 255, 0.08)"
                    color={tokens.colors.text.primary}
                    _placeholder={{ color: tokens.colors.text.muted }}
                    _hover={{ borderColor: 'rgba(255, 255, 255, 0.16)' }}
                    _focus={{
                      borderColor: tokens.colors.accent.primary,
                      boxShadow: `0 0 0 1px ${tokens.colors.accent.primary}`,
                      outline: 'none',
                    }}
                    fontSize="13px"
                    h="38px"
                    pr={isPassword ? '40px' : '12px'}
                    fontFamily={isPassword ? 'mono' : undefined}
                  />
                  {isPassword && (
                    <Box
                      as="button"
                      position="absolute"
                      right="8px"
                      top="50%"
                      transform="translateY(-50%)"
                      w="28px"
                      h="28px"
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      bg="transparent"
                      border="none"
                      cursor="pointer"
                      color={tokens.colors.text.muted}
                      _hover={{ color: tokens.colors.text.primary }}
                      onClick={() => toggleReveal(field.id)}
                      aria-label={reveal ? 'Hide value' : 'Reveal value'}
                    >
                      {reveal ? <FiEyeOff size={14} /> : <FiEye size={14} />}
                    </Box>
                  )}
                </Box>
                {field.helperText && (
                  <Text fontSize="11px" color={tokens.colors.text.muted} mt="6px" lineHeight="1.4">
                    {field.helperText}
                  </Text>
                )}
              </Box>
            )
          })}
        </Flex>

        {error && (
          <Text fontSize="12px" color={tokens.colors.accent.red} mt={3}>
            {error}
          </Text>
        )}
      </Box>

      {/* Actions */}
      <Flex
        gap={2}
        px={4}
        py={3}
        bg="rgba(0, 0, 0, 0.2)"
        borderTop="1px solid rgba(255, 255, 255, 0.06)"
      >
        {/* Real <Button> instead of <Box as="button"> so the disabled state
            is honored by both pointer events and the accessibility tree. The
            previous aria-disabled hack still let click-through happen if a
            screen reader user activated the element via the keyboard. */}
        <Button
          flex="1"
          h="36px"
          gap="6px"
          bg={`linear-gradient(135deg, ${tokens.colors.accent.primary} 0%, ${tokens.colors.accent.primaryDark} 100%)`}
          color="#fff"
          border="none"
          borderRadius="8px"
          fontSize="12.5px"
          fontWeight="600"
          transition="all 0.15s"
          _hover={{ boxShadow: `0 4px 16px -4px ${tokens.colors.accent.primaryGlow}` }}
          _disabled={{
            bg: 'rgba(255, 255, 255, 0.06)',
            color: tokens.colors.text.muted,
            cursor: 'not-allowed',
            opacity: 0.6,
          }}
          onClick={handleSubmit}
          loading={submitting}
          loadingText="Saving…"
          disabled={!isValid || submitting}
        >
          <FiCheck size={13} />
          Save securely
        </Button>
        <Button
          h="36px"
          px={4}
          gap="6px"
          bg="transparent"
          color={tokens.colors.text.secondary}
          border="1px solid rgba(255, 255, 255, 0.08)"
          borderRadius="8px"
          fontSize="12.5px"
          fontWeight="500"
          transition="all 0.15s"
          _hover={{ bg: 'rgba(255, 255, 255, 0.04)', color: tokens.colors.text.primary }}
          onClick={handleCancel}
        >
          Skip
        </Button>
      </Flex>
    </Box>
  )
}

export default memo(CredentialRequestCard)
