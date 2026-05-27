import { useEffect, useRef, useState } from 'react'
import { Box, Flex, Text, Textarea } from '@chakra-ui/react'
import { FiAlertTriangle, FiLock } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

/**
 * Inline permission prompt that replaces the PromptBar when a tool
 * invocation requires user approval.
 *
 * Four options for normal tools:
 *  1. Yes, allow this time
 *  2. Yes, and always allow 'X' in this project
 *  3. Yes, and always allow 'X' (global)
 *  4. No (tell the agent what to do instead)
 *
 * Two options for dangerous tools:
 *  1. Yes, allow this time
 *  4. No (tell the agent what to do instead)
 */
interface PermissionDialogProps {
  toolName: string
  args: Record<string, unknown>
  promptReason: string | null
  approve: () => void
  approveAlwaysInProject: () => void
  approveAlwaysGlobal: () => void
  deny: () => void
  denyWith: (reason: string) => void
}

type OptionKey = 'once' | 'project' | 'global' | 'deny'

export default function PermissionDialog({
  toolName,
  args,
  promptReason,
  approve,
  approveAlwaysInProject,
  approveAlwaysGlobal,
  deny,
  denyWith,
}: PermissionDialogProps) {
  const [selected, setSelected] = useState<OptionKey>('once')
  const [showReason, setShowReason] = useState(false)
  const [reason, setReason] = useState('')
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const isDangerous =
    promptReason === 'dangerous_command' ||
    toolName === 'delete_file' ||
    toolName === 'execute_command'

  // Reset on new permission
  useEffect(() => {
    setSelected('once')
    setShowReason(false)
    setReason('')
  }, [toolName, JSON.stringify(args)])

  // Focus reason textarea when visible
  useEffect(() => {
    if (showReason && reasonRef.current) reasonRef.current.focus()
  }, [showReason])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in textarea
      if (e.target instanceof HTMLTextAreaElement) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          handleSubmit()
        }
        return
      }

      if (e.key === '1') { e.preventDefault(); setSelected('once') }
      if (!isDangerous && e.key === '2') { e.preventDefault(); setSelected('project') }
      if (!isDangerous && e.key === '3') { e.preventDefault(); setSelected('global') }
      if (e.key === '4' || (isDangerous && e.key === '2')) {
        e.preventDefault()
        setSelected('deny')
        setShowReason(true)
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        handleSubmit()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        deny()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  })

  const handleSubmit = () => {
    if (selected === 'once') approve()
    else if (selected === 'project') approveAlwaysInProject()
    else if (selected === 'global') approveAlwaysGlobal()
    else if (selected === 'deny') {
      if (reason.trim()) denyWith(reason.trim())
      else deny()
    }
  }

  const icon = isDangerous ? <FiAlertTriangle /> : <FiLock />
  const iconColor = isDangerous ? tokens.colors.accent.orange : tokens.colors.accent.purple

  const label =
    toolName === 'browser_action'
      ? args.action as string
      : toolName === 'execute_command'
        ? (args.command as string || toolName)
        : (args.file_path as string || args.path as string || args.url as string || toolName)

  const isCommand = toolName === 'execute_command' || promptReason === 'dangerous_command'

  const reasonTag =
    promptReason === 'sensitive_file' ? t('perm.sensitiveFile') :
    promptReason === 'dangerous_command' ? t('perm.dangerousCommand') :
    promptReason === 'browser_action' ? t('perm.browserAction') :
    null

  return (
    <Box
      ref={containerRef}
      px={4}
      pt={3}
      pb={3}
      bg={tokens.colors.bg.mainLayout}
      flexShrink={0}
      borderTop="1px solid rgba(255, 255, 255, 0.06)"
    >
      <Box maxW="680px" mx="auto">
        {/* Header */}
        <Flex align="center" gap={2} mb={2}>
          <Box as="span" color={iconColor} display="flex" alignItems="center" flexShrink={0}>
            {icon}
          </Box>
          <Text fontSize="13px" fontWeight={600} color={tokens.colors.text.primary}>
            {isCommand ? t('perm.allowCommand') : t('perm.allowAction')}
          </Text>
        </Flex>

        {/* Tool label */}
        <Flex align="center" gap={2} mb={3}>
          <Text
            fontSize="12px"
            fontFamily="mono"
            color={tokens.colors.text.secondary}
            truncate
            title={label}
            flex={1}
          >
            {label}
          </Text>
          {reasonTag && (
            <Text fontSize="11px" color={iconColor} flexShrink={0}>
              {reasonTag}
            </Text>
          )}
        </Flex>

        {/* Options */}
        <Flex direction="column" gap={1} mb={2}>
          <OptionRow
            index={1}
            label={t('perm.allowThisTime')}
            selected={selected === 'once'}
            onClick={() => { setSelected('once'); setShowReason(false) }}
          />
          {!isDangerous && (
            <>
              <OptionRow
                index={2}
                label={t('perm.allowAlwaysProject').replace('{tool}', toolName)}
                selected={selected === 'project'}
                onClick={() => { setSelected('project'); setShowReason(false) }}
              />
              <OptionRow
                index={3}
                label={t('perm.allowAlwaysGlobal').replace('{tool}', toolName)}
                selected={selected === 'global'}
                onClick={() => { setSelected('global'); setShowReason(false) }}
              />
            </>
          )}
          <OptionRow
            index={isDangerous ? 2 : 4}
            label={t('perm.denyWithReason')}
            selected={selected === 'deny'}
            onClick={() => { setSelected('deny'); setShowReason(true) }}
          />
        </Flex>

        {/* Reason textarea (shown when deny is selected) */}
        {showReason && selected === 'deny' && (
          <Box mb={2}>
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
              minH="40px"
              maxH="64px"
              resize="none"
              color={tokens.colors.text.primary}
              _placeholder={{ color: tokens.colors.text.disabled }}
              _focus={{ borderColor: tokens.colors.accent.purple, boxShadow: 'none' }}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
            />
            <Text fontSize="10px" color={tokens.colors.text.disabled} mt={1}>
              {t('perm.reasonHint')}
            </Text>
          </Box>
        )}

        {/* Bottom bar */}
        <Flex justify="flex-end" align="center" gap={2}>
          <Box
            as="button"
            px={3}
            py="5px"
            borderRadius="6px"
            fontSize="12px"
            fontWeight={500}
            color={tokens.colors.text.muted}
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ color: tokens.colors.text.secondary, bg: 'rgba(255,255,255,0.05)' }}
            onClick={deny}
          >
            {t('perm.skip')}
          </Box>
          <Box
            as="button"
            px={4}
            py="5px"
            borderRadius="6px"
            fontSize="12px"
            fontWeight={600}
            bg={tokens.colors.accent.primary}
            color="white"
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ opacity: 0.9 }}
            onClick={handleSubmit}
          >
            {t('perm.submit')}
          </Box>
        </Flex>
      </Box>
    </Box>
  )
}

/** Single option row: number badge + label text */
function OptionRow({ index, label, selected, onClick }: {
  index: number
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <Flex
      align="center"
      gap={2}
      px={2}
      py="4px"
      borderRadius="6px"
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      bg={selected ? 'rgba(255, 255, 255, 0.06)' : 'transparent'}
      _hover={{ bg: 'rgba(255, 255, 255, 0.06)' }}
      onClick={onClick}
    >
      <Box
        minW="18px"
        h="18px"
        borderRadius="4px"
        bg={selected ? tokens.colors.accent.primary : 'rgba(255, 255, 255, 0.08)'}
        color={selected ? 'white' : tokens.colors.text.muted}
        fontSize="10px"
        fontWeight={600}
        display="flex"
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
      >
        {index}
      </Box>
      <Text
        fontSize="12px"
        color={selected ? tokens.colors.text.primary : tokens.colors.text.secondary}
        fontWeight={selected ? 500 : 400}
      >
        {label}
      </Text>
    </Flex>
  )
}
