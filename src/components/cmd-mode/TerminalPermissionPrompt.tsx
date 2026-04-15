import { memo, useEffect } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

type PromptReason = 'sensitive_file' | 'dangerous_command' | null

interface TerminalPermissionPromptProps {
  toolName: string
  args: Record<string, unknown>
  promptReason?: PromptReason
  onApprove: () => void
  onApproveAll: () => void
  onDeny: () => void
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getArgPreview(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'create_file':
    case 'delete_file':
    case 'create_directory':
      return (args.path as string) || null
    case 'rename_file':
      return `${args.oldPath} → ${args.newName}`
    case 'execute_command':
      return (args.command as string) || null
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
  promptReason === 'sensitive_file' ||
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
}: TerminalPermissionPromptProps) {
  const preview = getArgPreview(toolName, args)
  const warning = getWarningText(toolName, promptReason)
  const dangerous = isDangerous(toolName, promptReason)

  const accentColor = dangerous ? tokens.colors.accent.orange : tokens.colors.accent.purple
  const borderColor = dangerous ? 'rgba(247,127,0,0.3)' : 'rgba(163,113,247,0.25)'

  // Keyboard: Y/Enter = approve · A/Shift+Enter = approve all · N/Esc = deny
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.tagName === 'TEXTAREA') return

      if (e.key === 'y' || e.key === 'Y' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        onApprove()
      } else if (e.key === 'a' || e.key === 'A' || (e.key === 'Enter' && e.shiftKey)) {
        e.preventDefault()
        onApproveAll()
      } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
        e.preventDefault()
        onDeny()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onApprove, onApproveAll, onDeny])

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

      {/* Keyboard hint row — no buttons, purely visual */}
      <Flex align="center" gap={1} mt={1.5}>
        <KeyHint label="y" description="yes" color={tokens.colors.terminal.green} />
        <Sep />
        <KeyHint label="a" description="yes, always" color={tokens.colors.accent.purple} />
        <Sep />
        <KeyHint label="n" description="no" color={tokens.colors.accent.red} />
        <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} ml={2}>
          · esc cancels
        </Text>
      </Flex>
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

function KeyHint({ label, description, color }: { label: string; description: string; color: string }) {
  return (
    <Flex align="center" gap={1}>
      <Box
        px="4px"
        borderRadius="2px"
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
