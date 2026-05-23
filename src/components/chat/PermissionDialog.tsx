import { useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Text, Textarea } from '@chakra-ui/react'
import { FiAlertTriangle, FiLock, FiChevronDown, FiChevronUp } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { usePermissionStore } from '@/stores/permissionStore'
import { t } from '@/i18n'

/**
 * Modal dialog that asks the user to approve or deny a tool invocation.
 *
 * Two layouts depending on risk:
 *  - **Dangerous** (dangerous_command): only [Sim] [Nao] — no bulk actions.
 *  - **Normal** (sensitive_file, browser_action, null):
 *    [Sim] [Sim para todos] [Nao] [Nao para todos] — "Nao" toggles an
 *    optional reason textarea so the user can explain their decision.
 */
export default function PermissionDialog() {
  const pending = usePermissionStore(s => s.pendingPermission)
  const approve = usePermissionStore(s => s.approve)
  const approveAll = usePermissionStore(s => s.approveAll)
  const deny = usePermissionStore(s => s.deny)
  const denyAll = usePermissionStore(s => s.denyAll)
  const denyWith = usePermissionStore(s => s.denyWith)

  const [showReason, setShowReason] = useState(false)
  const [reason, setReason] = useState('')
  const [showArgs, setShowArgs] = useState(false)
  const reasonRef = useRef<HTMLTextAreaElement>(null)

  // Reset local state when a new permission request arrives
  useEffect(() => {
    if (pending) {
      setShowReason(false)
      setReason('')
      setShowArgs(false)
    }
  }, [pending?.id])

  // Focus the reason textarea when it becomes visible
  useEffect(() => {
    if (showReason && reasonRef.current) {
      reasonRef.current.focus()
    }
  }, [showReason])

  // Keyboard shortcuts: Enter = approve, Escape = deny
  useEffect(() => {
    if (!pending) return
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when user is typing in the reason textarea
      if (e.target instanceof HTMLTextAreaElement) {
        // Cmd/Ctrl+Enter still approves from within the textarea
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          approve()
        }
        return
      }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        e.stopPropagation()
        approve()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        deny()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [pending?.id, approve, deny])

  if (!pending) return null

  // Dangerous tools get the simplified Y/N layout.
  // Matches: destructive commands (promptReason) and always-risky tool
  // names. Sensitive files and browser actions get the full button set
  // so the user can "approve all" when the agent reads many files.
  const isDangerous =
    pending.promptReason === 'dangerous_command' ||
    pending.toolName === 'delete_file' ||
    pending.toolName === 'execute_command'
  const icon = isDangerous ? <FiAlertTriangle /> : <FiLock />
  const iconColor = isDangerous ? tokens.colors.accent.orange : tokens.colors.accent.purple

  const handleDeny = () => {
    if (reason.trim()) {
      denyWith(reason.trim())
    } else {
      deny()
    }
  }

  const reasonTag =
    pending.promptReason === 'sensitive_file' ? t('perm.sensitiveFile') :
    pending.promptReason === 'dangerous_command' ? t('perm.dangerousCommand') :
    pending.promptReason === 'browser_action' ? t('perm.browserAction') :
    null

  const label =
    pending.toolName === 'browser_action'
      ? pending.args.action as string
      : pending.toolName === 'execute_command'
        ? (pending.args.command as string || pending.toolName as string)
        : pending.args.file_path as string
          || pending.args.path as string
          || pending.args.url as string
          || pending.toolName as string

  return (
    <Box
      position="fixed"
      bottom="60px"
      left="50%"
      transform="translateX(-50%)"
      zIndex={10000}
      bg={tokens.colors.bg.overlay}
      borderRadius="12px"
      boxShadow="0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08)"
      backdropFilter="blur(20px)"
      overflow="hidden"
      maxW="480px"
      w="calc(100% - 160px)"
      animation="slideUp 0.2s ease-out"
      css={{
        '@keyframes slideUp': {
          from: { opacity: 0, transform: 'translateX(-50%) translateY(10px)' },
          to: { opacity: 1, transform: 'translateX(-50%) translateY(0)' },
        },
      }}
    >
      {/* Header */}
      <Flex align="center" gap={2} px={4} pt={3} pb={2}>
        <Box as="span" color={iconColor} display="flex" alignItems="center" flexShrink={0}>
          {icon}
        </Box>
        <Text fontSize="13px" fontWeight={600} color={tokens.colors.text.primary}>
          {isDangerous ? t('perm.dangerousTitle') : t('perm.approveTitle')}
        </Text>
      </Flex>

      {/* Tool label + reason */}
      <Box px={4} pb={3}>
        <Text
          fontSize="12px"
          fontFamily="mono"
          color={tokens.colors.text.secondary}
          truncate
          title={label}
          mb={reasonTag ? 1 : 0}
        >
          {label}
        </Text>
        {reasonTag && (
          <Text fontSize="11px" color={iconColor}>
            {reasonTag}
          </Text>
        )}
      </Box>

      {/* Args toggle */}
      {hasDisplayableArgs(pending.toolName, pending.args) && (
        <Box px={4} pb={2}>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowArgs(!showArgs)}
            color={tokens.colors.text.muted}
            fontSize="11px"
            h="24px"
            px={1}
            gap={1}
            _hover={{ color: tokens.colors.text.secondary, bg: 'transparent' }}
          >
            {showArgs ? <FiChevronUp size={12} /> : <FiChevronDown size={12} />}
            {showArgs ? t('perm.hideArgs') : t('perm.showArgs')}
          </Button>
          {showArgs && (
            <Box
              mt={1}
              p={2}
              bg="rgba(0,0,0,0.3)"
              borderRadius="8px"
              fontSize="11px"
              fontFamily="mono"
              color={tokens.colors.text.muted}
              maxH="160px"
              overflowY="auto"
              whiteSpace="pre-wrap"
              wordBreak="break-all"
            >
              {formatArgsForDisplay(pending.args)}
            </Box>
          )}
        </Box>
      )}

      {/* Reason textarea (non-dangerous only, when "Nao" is about to be clicked) */}
      {showReason && !isDangerous && (
        <Box px={4} pb={2}>
          <Textarea
            ref={reasonRef}
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder={t('perm.reasonPlaceholder')}
            size="xs"
            fontSize="11px"
            bg="rgba(0,0,0,0.3)"
            border="1px solid"
            borderColor="rgba(255,255,255,0.06)"
            borderRadius="8px"
            minH="48px"
            maxH="80px"
            resize="none"
            color={tokens.colors.text.primary}
            _placeholder={{ color: tokens.colors.text.disabled }}
            _focus={{ borderColor: tokens.colors.accent.purple, boxShadow: 'none' }}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                handleDeny()
              }
            }}
          />
          <Text fontSize="10px" color={tokens.colors.text.disabled} mt={1}>
            {t('perm.reasonHint')}
          </Text>
        </Box>
      )}

      {/* Buttons */}
      <Flex
        gap={2}
        px={4}
        py={3}
        bg="rgba(0,0,0,0.15)"
        justifyContent={isDangerous ? 'center' : 'flex-end'}
      >
        {/* Non-dangerous: full set of buttons */}
        {!isDangerous && (
          <>
            {/* "Nao para todos" */}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => denyAll()}
              color={tokens.colors.text.muted}
              fontSize="11px"
              h="28px"
              px={2}
              _hover={{ color: tokens.colors.text.secondary, bg: 'transparent' }}
            >
              {t('perm.denyAll')}
            </Button>

            {/* "Nao" — first click shows reason textarea, second click confirms */}
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                if (showReason) {
                  handleDeny()
                } else {
                  setShowReason(true)
                }
              }}
              color={tokens.colors.accent.red}
              borderColor="rgba(248,81,73,0.3)"
              fontSize="11px"
              h="28px"
              px={3}
              _hover={{ bg: 'rgba(248,81,73,0.1)', borderColor: 'rgba(248,81,73,0.5)' }}
            >
              {t('perm.deny')}
            </Button>

            {/* "Sim" */}
            <Button
              size="xs"
              variant="outline"
              onClick={() => approve()}
              color={tokens.colors.accent.primary}
              borderColor="rgba(254,16,99,0.3)"
              fontSize="11px"
              h="28px"
              px={3}
              _hover={{ bg: 'rgba(254,16,99,0.1)', borderColor: 'rgba(254,16,99,0.5)' }}
            >
              {t('perm.approve')}
            </Button>

            {/* "Sim para todos" */}
            <Button
              size="xs"
              onClick={() => approveAll()}
              bg={tokens.colors.accent.primary}
              color="white"
              fontSize="11px"
              fontWeight={600}
              h="28px"
              px={3}
              _hover={{ opacity: 0.9 }}
            >
              {t('perm.approveAll')}
            </Button>
          </>
        )}

        {/* Dangerous: only Sim / Nao */}
        {isDangerous && (
          <>
            <Button
              size="xs"
              variant="outline"
              onClick={() => deny()}
              color={tokens.colors.accent.red}
              borderColor="rgba(248,81,73,0.3)"
              fontSize="12px"
              fontWeight={600}
              h="32px"
              px={6}
              _hover={{ bg: 'rgba(248,81,73,0.1)', borderColor: 'rgba(248,81,73,0.5)' }}
            >
              {t('perm.deny')}
            </Button>
            <Button
              size="xs"
              onClick={() => approve()}
              bg={tokens.colors.accent.primary}
              color="white"
              fontSize="12px"
              fontWeight={600}
              h="32px"
              px={6}
              _hover={{ opacity: 0.9 }}
            >
              {t('perm.approve')}
            </Button>
          </>
        )}
      </Flex>
    </Box>
  )
}

/** Args that aren't useful to display to the user */
const HIDDEN_ARG_KEYS = new Set(['timeout_ms'])

/**
 * Returns true if the tool has args worth displaying.
 * Some tools (read_file) already show the file path as the label.
 */
function hasDisplayableArgs(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'browser_action') return false
  const keys = Object.keys(args).filter(k => !HIDDEN_ARG_KEYS.has(k))
  if (keys.length === 0) return false
  // If there's only one key and it's already used as the label, hide
  if (keys.length === 1 && (keys[0] === 'file_path' || keys[0] === 'path')) return false
  return true
}

/** Format args for display, excluding noise */
function formatArgsForDisplay(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([k]) => !HIDDEN_ARG_KEYS.has(k))
    .map(([k, v]) => {
      if (typeof v === 'string' && v.length > 200) {
        return `${k}: ${v.slice(0, 200)}...`
      }
      return `${k}: ${typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}`
    })
    .join('\n')
}
