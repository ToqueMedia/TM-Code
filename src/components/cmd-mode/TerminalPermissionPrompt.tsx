import { memo, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { useTranslation } from '@/i18n/useTranslation'
import { usePermissionStore, type PromptReason } from '../../stores/permissionStore'

interface TerminalPermissionPromptProps {
  toolName: string
  args: Record<string, unknown>
  promptReason?: PromptReason
  onApprove: () => void
  onApproveAll: () => void
  onDeny: () => void
  onDenyAll: () => void
  /** "Write" a custom reason for denial — the reason is surfaced to the agent
   *  in the tool result (instead of the generic "Ask the user what they want"). */
  onDenyWith?: (reason: string) => void
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** How long after mount before keyboard shortcuts take effect (ms). */
const KEY_ARMING_MS = 350

function getArgPreview(toolName: string, args: Record<string, unknown>): string | null {
  // Pick the first non-empty string from a list of candidate keys.
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = args[k]
      if (typeof v === 'string' && v.length > 0) return v
    }
    return null
  }
  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'create_file':
    case 'delete_file':
    case 'edit_file':
    case 'create_directory':
      return pick('file_path', 'path')
    case 'rename_file': {
      const from = pick('file_path', 'oldPath', 'old_path', 'path')
      const to = pick('new_path', 'newPath', 'newName')
      return from && to ? `${from} → ${to}` : from || to
    }
    case 'execute_command':
      return pick('command')
    case 'web_fetch':
    case 'web_search':
      return pick('url', 'query')
    default: {
      const first = Object.values(args)[0]
      if (typeof first === 'string') return first.length > 80 ? first.slice(0, 80) + '…' : first
      return null
    }
  }
}

function getWarningText(toolName: string, promptReason?: PromptReason): string | null {
  if (promptReason === 'sensitive_file') return t('terminalMode.permission.sensitiveFile')
  if (promptReason === 'dangerous_command') return t('terminalMode.permission.destructiveCommand')
  if (toolName === 'delete_file') return t('terminalMode.permission.irreversible')
  return null
}

const isDangerous = (toolName: string, promptReason?: PromptReason) =>
  promptReason === 'dangerous_command' ||
  toolName === 'delete_file' ||
  toolName === 'execute_command'

// ── Component ─────────────────────────────────────────────────────────────────

export const TerminalPermissionPrompt = memo(function TerminalPermissionPrompt({
  toolName,
  args,
  promptReason,
  onApprove,
  onApproveAll,
  onDeny,
  onDenyAll,
  onDenyWith,
}: TerminalPermissionPromptProps) {
  const t = useTranslation()
  const preview = getArgPreview(toolName, args)
  const warning = getWarningText(toolName, promptReason)
  const dangerous = isDangerous(toolName, promptReason)
  // Destructive operations (dangerous_command, sensitive_file, delete_file,
  // execute_command) must NOT offer "approve all" — every action requires
  // explicit individual authorization from the user.
  const hideApproveAll = dangerous

  // Refined-terminal: standardize the structural accent on purple — the gutter,
  // border, panel tint and title no longer flip to orange for dangerous prompts.
  // Destructive semantics are still carried by the red deny rows below.
  const accentColor = tokens.colors.accent.purple
  const borderColor = 'rgba(163,113,247,0.34)'
  const panelBg = 'rgba(163, 113, 247, 0.035)'
  const promptTitle = dangerous ? t('perm.dangerousTitle') : t('terminalMode.permission.title')
  const question = toolName === 'execute_command' || promptReason === 'dangerous_command'
    ? t('perm.allowCommand')
    : t('perm.allowAction')

  // Two modes: 'choose' (y/a/n/w keys) and 'writing' (textarea for deny reason).
  const [mode, setMode] = useState<'choose' | 'writing' | 'confirm-all'>('choose')
  const [reason, setReason] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Arming delay — the prompt can appear mid-typing (the agent requests a
  // permission while the user is writing in the prompt input). Keystrokes
  // already in flight would otherwise land on the y/n/Enter handlers below
  // and approve/deny something the user never saw. Ignore keys until the
  // prompt has been visible long enough to be perceived. Key-repeats are
  // ignored for the same reason (Enter held down from before the prompt).
  const armedAtRef = useRef(0)
  useEffect(() => {
    armedAtRef.current = performance.now() + KEY_ARMING_MS
  }, [])
  const isArmed = () => performance.now() >= armedAtRef.current

  // Auto-focus textarea when switching to writing mode.
  useEffect(() => {
    if (mode === 'writing') textareaRef.current?.focus()
  }, [mode])

  // Handle approveAll with confirmation if queue is large
  const handleApproveAllWithConfirmation = () => {
    const queuedCount = usePermissionStore.getState().getQueuedCount()
    if (queuedCount > 2) {
      setMode('confirm-all')
    } else {
      onApproveAll()
    }
  }

  const handleConfirmAll = () => {
    setMode('choose')
    onApproveAll()
  }

  const handleCancelConfirmAll = () => {
    setMode('choose')
  }

  // Keyboard: in 'choose' mode — Y/Enter=approve, A/Shift+Enter=approve all,
  // N=deny, W=write reason, Esc=deny. In 'writing' mode — textarea handles
  // its own input; Enter submits, Shift+Enter newline, Esc returns to choose.
  // In 'confirm-all' mode — Y/Enter=confirm, N/Esc=cancel.
  useEffect(() => {
    if (mode === 'confirm-all') {
      function handleKeyDown(e: KeyboardEvent) {
        if (!isArmed() || e.repeat) return
        if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') {
          e.preventDefault()
          handleConfirmAll()
        } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
          e.preventDefault()
          handleCancelConfirmAll()
        }
      }
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }

    if (mode !== 'choose') return
    function handleKeyDown(e: KeyboardEvent) {
      if (!isArmed() || e.repeat) return
      const target = e.target as HTMLElement
      if (target.tagName === 'TEXTAREA') return

      if (e.key === 'y' || e.key === 'Y' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        onApprove()
      } else if (!hideApproveAll && (e.key === 'a' || e.key === 'A' || (e.key === 'Enter' && e.shiftKey))) {
        e.preventDefault()
        handleApproveAllWithConfirmation()
      } else if (!dangerous && (e.key === 'w' || e.key === 'W')) {
        if (!onDenyWith) return
        e.preventDefault()
        setMode('writing')
      } else if (!dangerous && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        onDenyAll()
      } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
        e.preventDefault()
        onDeny()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [mode, dangerous, onApprove, onDeny, onDenyAll, onDenyWith, hideApproveAll])

  const handleSubmitReason = () => {
    if (!onDenyWith) return
    onDenyWith(reason)
    setReason('')
    setMode('choose')
  }

  const handleCancelWriting = () => {
    setReason('')
    setMode('choose')
  }

  return (
    <Box
      mx={3}
      mb={2.5}
      px={3}
      py={2.5}
      bg={panelBg}
      border="1px solid"
      borderColor="rgba(255,255,255,0.08)"
      borderLeft={`3px solid ${borderColor}`}
      // Refined-terminal: flat — bound by the left gutter only, no drop shadow.
      borderRadius={tokens.radius.sm}
      fontFamily={tokens.fontFamily.mono}
      data-ui-chrome
    >
      <Text
        fontSize="13px"
        lineHeight="1.5"
        color={tokens.colors.text.primary}
        fontWeight="700"
        letterSpacing="0"
        mb={2}
      >
        {promptTitle}
      </Text>

      <Box
        borderTop="1px solid rgba(255,255,255,0.07)"
        pt={2}
      >
        <Flex align="baseline" gap={2} minW={0}>
          <Text fontSize="11px" color={tokens.colors.text.disabled} flexShrink={0}>
            {t('terminalMode.permission.tool')}:
          </Text>
          <Text fontSize="13px" color={tokens.colors.text.primary} fontWeight="700" flexShrink={0}>
            {toolName}
          </Text>
        </Flex>

        {preview && (
          <Flex align="flex-start" gap={2} mt={1} minW={0}>
            <Text fontSize="11px" color={tokens.colors.text.disabled} flexShrink={0}>
              {toolName === 'execute_command' ? t('terminalMode.permission.command') : t('terminalMode.permission.target')}:
            </Text>
            <Text
              fontSize="13px"
              lineHeight="1.45"
              color={dangerous ? tokens.colors.accent.red : tokens.colors.text.secondary}
              wordBreak="break-word"
              overflowWrap="anywhere"
              minW={0}
            >
              {preview}
            </Text>
          </Flex>
        )}

        {warning && (
          <Text fontSize="11px" color={dangerous ? tokens.colors.accent.red : accentColor} opacity={0.92} mt={1.5}>
            [{warning}]
          </Text>
        )}
      </Box>

      {/* Keyboard hint row OR write-reason textarea OR confirm-all prompt */}
      {mode === 'confirm-all' ? (
        <Box mt={2.5}>
          <Text fontSize="12px" color={tokens.colors.accent.orange} fontFamily={tokens.fontFamily.mono} mb={1.5}>
            {t('terminalMode.permission.approveAllWarning').replace('{count}', String(usePermissionStore.getState().getQueuedCount()))}
          </Text>
          <Flex direction="column" gap={1}>
            <OptionRow shortcut="y" label={t('perm.confirmAll')} color={tokens.colors.terminal.green} onClick={handleConfirmAll} />
            <OptionRow shortcut="n" label={t('perm.cancel')} color={tokens.colors.accent.red} onClick={handleCancelConfirmAll} />
          </Flex>
        </Box>
      ) : mode === 'choose' ? (
        <Box mt={2.5}>
          <Text fontSize="13px" lineHeight="1.45" color={tokens.colors.text.primary} mb={1.5}>
            {question}
          </Text>
          <Flex direction="column" gap={0.5}>
            {dangerous ? (
              <>
                <OptionRow shortcut="y" label={t('perm.allowThisTime')} color={tokens.colors.terminal.green} onClick={onApprove} />
                <OptionRow shortcut="n" label={t('perm.deny')} color={tokens.colors.accent.red} onClick={onDeny} />
              </>
            ) : (
              <>
                <OptionRow shortcut="y" label={t('perm.allowThisTime')} color={tokens.colors.terminal.green} onClick={onApprove} />
                <OptionRow shortcut="a" label={t('perm.approveAll')} color={tokens.colors.accent.purple} onClick={handleApproveAllWithConfirmation} />
                <OptionRow shortcut="n" label={t('perm.deny')} color={tokens.colors.accent.red} onClick={onDeny} />
                <OptionRow shortcut="d" label={t('perm.denyAll')} color={tokens.colors.accent.red} onClick={onDenyAll} />
                {/* Refined-terminal: deny-with-reason is non-destructive — purple, not orange. */}
                <OptionRow shortcut="w" label={t('perm.denyWithReason')} color={tokens.colors.accent.purple} onClick={() => setMode('writing')} />
              </>
            )}
          </Flex>
          <Text
            fontSize="11px"
            color={tokens.colors.text.disabled}
            fontFamily={tokens.fontFamily.mono}
            mt={1.5}
            cursor="pointer"
            onClick={onDeny}
            _hover={{ color: tokens.colors.text.muted }}
            transition="color 0.1s"
            userSelect="none"
          >
            {t('terminalMode.permission.shortcutHint')} - {t('terminalMode.permission.escCancels')}
          </Text>
        </Box>
      ) : (
        <Box mt={2.5}>
          <Text fontSize="13px" lineHeight="1.45" color={tokens.colors.text.primary} mb={1.5}>
            {t('perm.denyWithReason')}
          </Text>
          <textarea
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmitReason()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                handleCancelWriting()
              }
            }}
            placeholder={t('perm.reasonPlaceholder')}
            rows={2}
            style={{
              width: '100%',
              background: 'rgba(0,0,0,0.28)',
              // Refined-terminal: purple structural accent, flat 2px radius.
              border: `1px solid ${tokens.colors.accent.purple}44`,
              borderRadius: tokens.radius.sm,
              padding: '8px 10px',
              fontFamily: tokens.fontFamily.mono,
              fontSize: '12px',
              color: tokens.colors.terminal.foreground,
              outline: 'none',
              resize: 'none',
            }}
          />
          <Flex align="center" gap={1.5} mt={1.5} wrap="wrap">
            <KeyHint label="enter" description={t('terminalMode.permission.send')} color={tokens.colors.accent.purple} onClick={handleSubmitReason} />
            <KeyHint label="esc" description={t('terminalMode.permission.cancel')} color={tokens.colors.text.disabled} onClick={handleCancelWriting} />
            <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} userSelect="none">
              {t('terminalMode.permission.shiftEnterHint')}
            </Text>
          </Flex>
        </Box>
      )}
    </Box>
  )
})

function KeyHint({
  label,
  description,
  color,
  onClick,
}: {
  label: string
  description: string
  color: string
  onClick?: () => void
}) {
  const isClickable = !!onClick
  return (
    <Flex
      align="center"
      gap={1}
      onClick={onClick}
      cursor={isClickable ? 'pointer' : undefined}
      userSelect="none"
      // Refined-terminal: no lift/transform micro-interaction; a flat brightness
      // change is the only hover cue.
      _hover={
        isClickable
          ? {
              filter: 'brightness(1.15)',
              opacity: 1,
            }
          : undefined
      }
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
    >
      <Box
        px="4px"
        borderRadius={tokens.radius.sm}
        border="1px solid"
        borderColor={`${color}55`}
        bg={`${color}12`}
      >
        <Text fontSize="10px" color={color} fontFamily={tokens.fontFamily.mono} fontWeight="700" lineHeight="1.6">
          {label}
        </Text>
      </Box>
      <Text fontSize="11px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono}>
        {description}
      </Text>
    </Flex>
  )
}

function OptionRow({
  shortcut,
  label,
  color,
  onClick,
}: {
  shortcut: string
  label: string
  color: string
  onClick: () => void
}) {
  return (
    <Flex
      as="button"
      align="center"
      gap={2}
      w="100%"
      minW={0}
      px={2}
      py={1}
      // Refined-terminal: 2px radius, flat — focus is a solid border, not a glow ring.
      borderRadius={tokens.radius.sm}
      color={tokens.colors.text.secondary}
      bg="transparent"
      border="1px solid transparent"
      textAlign="left"
      cursor="pointer"
      onClick={onClick}
      _hover={{
        bg: 'rgba(255,255,255,0.045)',
        borderColor: 'rgba(255,255,255,0.08)',
        color: tokens.colors.text.primary,
      }}
      _focusVisible={{
        outline: 'none',
        borderColor: color,
      }}
    >
      <Text color={color} fontSize="13px" fontWeight="800" flexShrink={0} lineHeight="1.4">
        &gt;
      </Text>
      <Text
        as="span"
        minW="28px"
        color={color}
        fontSize="12px"
        fontWeight="700"
        textAlign="center"
        lineHeight="1.4"
      >
        {shortcut}
      </Text>
      <Text
        as="span"
        color="inherit"
        fontSize="12px"
        lineHeight="1.45"
        minW={0}
        overflowWrap="anywhere"
      >
        {label}
      </Text>
    </Flex>
  )
}
