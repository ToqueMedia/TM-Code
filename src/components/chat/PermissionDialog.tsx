import { memo, useEffect } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiAlertTriangle, FiShield } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

type PromptReason = 'sensitive_file' | 'dangerous_command' | null

interface PermissionDialogProps {
  toolName: string
  args: Record<string, unknown>
  promptReason?: PromptReason
  /** @deprecated Use promptReason instead. Kept for compat. */
  sensitive?: boolean
  onApprove: () => void
  onApproveAll: () => void
  onDeny: () => void
}

function getToolLabel(toolName: string, promptReason?: PromptReason): string {
  if (promptReason === 'sensitive_file') return t('perm.readSensitive')
  if (promptReason === 'dangerous_command') return t('perm.dangerousCommand')
  switch (toolName) {
    case 'read_file': return t('perm.readFile')
    case 'write_file': return t('perm.writeFile')
    case 'create_file': return t('perm.createFile')
    case 'create_directory': return t('perm.createDir')
    case 'delete_file': return t('perm.deleteFile')
    case 'rename_file': return t('perm.renameFile')
    case 'execute_command': return t('perm.executeCommand')
    default: return toolName
  }
}

function getPreviewPath(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'create_file':
    case 'delete_file':
    case 'create_directory':
      return (args.path as string) || null
    case 'rename_file':
      // Path shown via content preview as "old → new", so skip here to avoid duplication
      return null
    default:
      return null
  }
}

function getPreviewContent(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === 'write_file' || toolName === 'create_file') {
    const content = args.content as string | undefined
    if (!content) return null
    const lines = content.split('\n')
    const preview = lines.slice(0, 20).join('\n')
    return lines.length > 20 ? preview + `\n... (+${lines.length - 20} lines)` : preview
  }
  if (toolName === 'execute_command') {
    return (args.command as string) || null
  }
  if (toolName === 'rename_file') {
    return `${args.oldPath} → ${args.newName}`
  }
  return null
}

const isDestructive = (toolName: string) =>
  toolName === 'delete_file' || toolName === 'execute_command'

const isWarning = (toolName: string, sensitive?: boolean) =>
  isDestructive(toolName) || !!sensitive

const buttonBase: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: '6px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  border: 'none',
  transition: 'all 0.15s ease',
}

function PermissionDialog({ toolName, args, promptReason, sensitive, onApprove, onApproveAll, onDeny }: PermissionDialogProps) {
  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'y' || e.key === 'Y') {
        e.preventDefault()
        onApprove()
      } else if ((e.key === 'Enter' && e.shiftKey) || e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        onApproveAll()
      } else if (e.key === 'Escape' || e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        onDeny()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onApprove, onApproveAll, onDeny])

  const path = getPreviewPath(toolName, args)
  const content = getPreviewContent(toolName, args)
  const warning = isWarning(toolName, sensitive)

  return (
    <Box
      mx={4}
      mb={2}
      bg={tokens.colors.bg.panel}
      border={`1px solid ${warning ? (sensitive ? 'rgba(247, 127, 0, 0.3)' : tokens.colors.accent.redMuted) : tokens.colors.border.panel}`}
      borderRadius="10px"
      overflow="hidden"
      maxW="900px"
      alignSelf="center"
      w="100%"
    >
      {/* Header */}
      <Flex align="center" gap={2} px={4} py={3}>
        {sensitive ? (
          <FiShield size={16} color={tokens.colors.accent.orange} />
        ) : warning ? (
          <FiAlertTriangle size={16} color={tokens.colors.accent.orange} />
        ) : (
          <Box
            w="8px"
            h="8px"
            borderRadius="full"
            bg={tokens.colors.toolCall.runningText}
            css={{
              animation: 'pulse 1.5s ease-in-out infinite',
              '@keyframes pulse': {
                '0%, 100%': { opacity: 1 },
                '50%': { opacity: 0.4 },
              },
            }}
          />
        )}
        <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
          {t("perm.agentWantsTo")} {getToolLabel(toolName, promptReason || (sensitive ? 'sensitive_file' : null))}
        </Text>
      </Flex>

      {/* Context warning based on prompt reason */}
      {(promptReason === 'sensitive_file' || (sensitive && !promptReason)) && (
        <Box px={4} pb={2}>
          <Text fontSize="11px" color={tokens.colors.accent.orange}>
            {t("perm.sensitiveWarning")}
          </Text>
        </Box>
      )}
      {promptReason === 'dangerous_command' && (
        <Box px={4} pb={2}>
          <Text fontSize="11px" color={tokens.colors.accent.orange}>
            {t("perm.dangerousWarning")}
          </Text>
        </Box>
      )}

      {/* Path */}
      {path && (
        <Box px={4} pb={2}>
          <Text
            fontSize="12px"
            fontFamily={tokens.fontFamily.mono}
            color={warning ? tokens.colors.accent.orange : tokens.colors.text.secondary}
          >
            {path}
          </Text>
        </Box>
      )}

      {/* Content Preview */}
      {content && (
        <Box px={4} pb={3}>
          <Box
            bg={tokens.colors.bg.codeBlock}
            borderRadius="6px"
            border={`1px solid ${tokens.colors.border.default}`}
            p={3}
            maxH="200px"
            overflowY="auto"
            css={{
              '&::-webkit-scrollbar': { width: '4px' },
              '&::-webkit-scrollbar-thumb': {
                background: tokens.colors.border.panel,
                borderRadius: '2px',
              },
            }}
          >
            <Text
              fontSize="11px"
              fontFamily={tokens.fontFamily.mono}
              color={toolName === 'execute_command' ? tokens.colors.accent.orange : tokens.colors.text.code}
              whiteSpace="pre-wrap"
              wordBreak="break-all"
              lineHeight="1.5"
            >
              {content}
            </Text>
          </Box>
        </Box>
      )}

      {/* Actions */}
      <Flex
        align="center"
        gap={2}
        px={4}
        py={3}
        borderTop={`1px solid ${tokens.colors.border.panel}`}
        bg={tokens.colors.bg.panelAlt}
      >
        <button
          onClick={onApprove}
          style={{
            ...buttonBase,
            background: tokens.colors.accent.green,
            color: '#fff',
          }}
        >
          Yes (Y)
        </button>
        <button
          onClick={onApproveAll}
          style={{
            ...buttonBase,
            background: 'transparent',
            border: `1px solid ${tokens.colors.accent.greenMuted}`,
            color: tokens.colors.accent.green,
          }}
        >
          Yes, for all (A)
        </button>
        <button
          onClick={onDeny}
          style={{
            ...buttonBase,
            background: 'transparent',
            border: `1px solid ${tokens.colors.accent.redMuted}`,
            color: tokens.colors.accent.red,
          }}
        >
          No (N)
        </button>
        <Text fontSize="11px" color={tokens.colors.text.disabled} ml="auto">
          Enter / Shift+Enter / Esc
        </Text>
      </Flex>
    </Box>
  )
}

export default memo(PermissionDialog)
