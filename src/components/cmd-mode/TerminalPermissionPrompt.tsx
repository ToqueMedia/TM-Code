import { memo, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

type PromptReason = 'sensitive_file' | 'dangerous_command' | 'browser_action' | null

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
  if (promptReason === 'sensitive_file') return 'sensitive file'
  if (promptReason === 'dangerous_command') return 'destructive command'
  if (toolName === 'delete_file') return 'irreversible'
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
  const preview = getArgPreview(toolName, args)
  const warning = getWarningText(toolName, promptReason)
  const dangerous = isDangerous(toolName, promptReason)
  // Destructive operations (dangerous_command, sensitive_file, delete_file,
  // execute_command) must NOT offer "approve all" — every action requires
  // explicit individual authorization from the user.
  const hideApproveAll = dangerous

  const accentColor = dangerous ? tokens.colors.accent.orange : tokens.colors.accent.purple
  const borderColor = dangerous ? 'rgba(247,127,0,0.3)' : 'rgba(163,113,247,0.25)'

  // Two modes: 'choose' (y/a/n/w keys) and 'writing' (textarea for deny reason).
  const [mode, setMode] = useState<'choose' | 'writing'>('choose')
  const [reason, setReason] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-focus textarea when switching to writing mode.
  useEffect(() => {
    if (mode === 'writing') textareaRef.current?.focus()
  }, [mode])

  // Keyboard: in 'choose' mode — Y/Enter=approve, A/Shift+Enter=approve all,
  // N=deny, W=write reason, Esc=deny. In 'writing' mode — textarea handles
  // its own input; Enter submits, Shift+Enter newline, Esc returns to choose.
  useEffect(() => {
    if (mode !== 'choose') return
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.tagName === 'TEXTAREA') return

      if (e.key === 'y' || e.key === 'Y' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        onApprove()
      } else if (!hideApproveAll && (e.key === 'a' || e.key === 'A' || (e.key === 'Enter' && e.shiftKey))) {
        e.preventDefault()
        onApproveAll()
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
  }, [mode, dangerous, onApprove, onApproveAll, onDeny, onDenyAll, onDenyWith, hideApproveAll])

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
      mb={2}
      pl={3}
      py={1.5}
      borderLeft={`2px solid ${borderColor}`}
      fontFamily={tokens.fontFamily.mono}
    >
      {/* Tool + arg line */}
      <Flex align="baseline" gap={1.5} wrap="wrap">
        <Text fontSize="11px" color={accentColor} fontWeight="700" flexShrink={0} userSelect="none">
          ?
        </Text>
        <Text fontSize="12px" color={tokens.colors.terminal.foreground} fontWeight="600" flexShrink={0}>
          {toolName}
        </Text>
        {warning && (
          <Text fontSize="10px" color={accentColor} opacity={0.85} flexShrink={0}>
            [{warning}]
          </Text>
        )}
        {preview && (
          <Text
            fontSize="12px"
            color={dangerous ? tokens.colors.accent.orange : tokens.colors.text.muted}
            wordBreak="break-all"
          >
            {preview}
          </Text>
        )}
      </Flex>

      {/* Keyboard hint row OR write-reason textarea */}
      {mode === 'choose' ? (
        <Flex align="center" gap={1} mt={1.5} wrap="wrap">
          {dangerous ? (
            <>
              <KeyHint label="y" description={t('perm.approve')} color={tokens.colors.terminal.green} onClick={onApprove} />
              <Sep />
              <KeyHint label="n" description={t('perm.deny')} color={tokens.colors.accent.red} onClick={onDeny} />
            </>
          ) : (
            <>
              <KeyHint label="y" description={t('perm.approve')} color={tokens.colors.terminal.green} onClick={onApprove} />
              <Sep />
              <KeyHint label="a" description={t('perm.approveAll')} color={tokens.colors.accent.purple} onClick={onApproveAll} />
              <Sep />
              <KeyHint label="n" description={t('perm.deny')} color={tokens.colors.accent.red} onClick={onDeny} />
              <Sep />
              <KeyHint label="d" description={t('perm.denyAll')} color={tokens.colors.accent.red} onClick={onDenyAll} />
              <Sep />
              <KeyHint label="w" description={t('perm.justify')} color={tokens.colors.accent.orange} onClick={() => setMode('writing')} />
            </>
          )}
          <Text
            fontSize="10px"
            color={tokens.colors.text.disabled}
            fontFamily={tokens.fontFamily.mono}
            ml={2}
            cursor="pointer"
            onClick={onDeny}
            _hover={{ color: tokens.colors.text.muted }}
            transition="color 0.1s"
            userSelect="none"
          >
            · esc cancels
          </Text>
        </Flex>
      ) : (
        <Box mt={1.5}>
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
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${tokens.colors.accent.orange}44`,
              borderRadius: '4px',
              padding: '6px 8px',
              fontFamily: tokens.fontFamily.mono,
              fontSize: '12px',
              color: tokens.colors.terminal.foreground,
              outline: 'none',
              resize: 'none',
            }}
          />
          <Flex align="center" gap={2} mt={1}>
            <KeyHint label="↵" description="send" color={tokens.colors.accent.orange} onClick={handleSubmitReason} />
            <Sep />
            <KeyHint label="esc" description="cancel" color={tokens.colors.text.disabled} onClick={handleCancelWriting} />
            <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} ml={2} userSelect="none">
              · shift+↵ for newline
            </Text>
          </Flex>
        </Box>
      )}
    </Box>
  )
})

function Sep() {
  return (
    <Text fontSize="10px" color="rgba(255,255,255,0.1)" fontFamily={tokens.fontFamily.mono} mx={1}>
      ·
    </Text>
  )
}

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
      transition="all 0.15s ease"
      _hover={
        isClickable
          ? {
              transform: 'translateY(-0.5px)',
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
        borderRadius="2px"
        border="1px solid"
        borderColor={`${color}55`}
        bg={`${color}12`}
        transition="all 0.15s ease"
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
