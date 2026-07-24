import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Text, Textarea, Input } from '@chakra-ui/react'
import { FiAlertTriangle, FiLock } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { usePermissionStore } from '../../stores/permissionStore'
import { getCommandPrefix } from '@/services/agent/commandPrefix'
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
 *
 * Three options for path_access (directory outside project):
 *  1. Allow access this session
 *  2. Always allow in this project
 *  3. Deny
 */
interface PermissionDialogProps {
  toolName: string
  args: Record<string, unknown>
  promptReason: string | null
  /** When promptReason is 'path_access', the directory being requested */
  pathAccessTarget?: string
  /** Descrição da tarefa paralela que originou o pedido (permissionStore
   *  origin) — o user tem de saber QUEM pergunta quando há multi-agentes. */
  originLabel?: string
  /** Razão do classificador do Modo Auto quando o diálogo surge por escalada
   *  (sinalizou risco em vez de negar) — mostrada para o developer ver PORQUÊ. */
  classifierReason?: string
  approve: () => void
  approveAlwaysInProject: (commandPrefix?: string) => void
  approveAlwaysGlobal: (commandPrefix?: string) => void
  deny: () => void
  denyWith: (reason: string) => void
}

type OptionKey = 'once' | 'project' | 'global' | 'deny'

export default function PermissionDialog({
  toolName,
  args,
  promptReason,
  pathAccessTarget,
  originLabel,
  classifierReason,
  approve,
  approveAlwaysInProject,
  approveAlwaysGlobal,
  deny,
  denyWith,
}: PermissionDialogProps) {
  const autoModePermissions = usePermissionStore(st => st.autoModePermissions)
  const setAutoModePermissions = usePermissionStore(st => st.setAutoModePermissions)
  const [selected, setSelected] = useState<OptionKey>('once')
  const [showReason, setShowReason] = useState(false)
  const [reason, setReason] = useState('')
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const isDangerous =
    promptReason === 'dangerous_command' ||
    toolName === 'delete_file'

  const isPathAccess = promptReason === 'path_access'

  // Grant por PREFIXO de comando (porte claude-vaz): para execute_command*, o
  // "sempre permitir" concede o PREFIXO (`gcloud secrets versions add`), não a
  // tool inteira. Sem prefixo extraível (composto/bare-shell/path) não há grant
  // "sempre" — só "desta vez" (evita recriar o grant largo do incidente).
  const command = typeof args.command === 'string' ? args.command : ''
  const isCommandScoped = toolName === 'execute_command' || toolName === 'execute_command_background'
  const extractedPrefix = useMemo(
    () => (isCommandScoped ? getCommandPrefix(command) : null),
    [isCommandScoped, command],
  )
  const [prefixDraft, setPrefixDraft] = useState(extractedPrefix ?? '')
  // Grants "sempre" só existem quando há prefixo (ou a tool não é de shell).
  const canGrantAlways = isCommandScoped ? extractedPrefix != null : true
  // Esconde as opções "sempre" quando são perigosas OU sem prefixo concedível.
  const hideAlways = isDangerous || !canGrantAlways

  // Reset on new permission
  useEffect(() => {
    setSelected('once')
    setShowReason(false)
    setReason('')
    setPrefixDraft(extractedPrefix ?? '')
  }, [toolName, JSON.stringify(args), extractedPrefix])

  // Focus reason textarea when visible
  useEffect(() => {
    if (showReason && reasonRef.current) reasonRef.current.focus()
  }, [showReason])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in form elements
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          handleSubmit()
        }
        return
      }

      if (e.key === '1') { e.preventDefault(); setSelected('once') }
      if (!hideAlways && e.key === '2') { e.preventDefault(); setSelected('project') }
      if (!hideAlways && !isPathAccess && e.key === '3') { e.preventDefault(); setSelected('global') }
      if (e.key === '4' || (hideAlways && e.key === '2') || (isPathAccess && e.key === '3')) {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, hideAlways, isPathAccess, showReason])

  const handleSubmit = () => {
    // Para comandos, passa o prefixo (editado ou extraído); o store sanitiza e
    // cai para o extraído se o input estiver vazio/inválido.
    const prefixArg = isCommandScoped ? prefixDraft : undefined
    if (selected === 'once') approve()
    else if (selected === 'project') approveAlwaysInProject(prefixArg)
    else if (selected === 'global') approveAlwaysGlobal(prefixArg)
    else if (selected === 'deny') {
      if (reason.trim()) denyWith(reason.trim())
      else deny()
    }
  }

  const icon = isDangerous ? <FiAlertTriangle /> : <FiLock />
  const iconColor = isDangerous
    ? tokens.colors.accent.orange
    : isPathAccess
      ? tokens.colors.accent.orange
      : tokens.colors.accent.purple

  const label = isPathAccess
    ? (pathAccessTarget || toolName)
    : toolName === 'browser_action'
      ? (typeof args.action === 'string' ? args.action : toolName)
      : isCommandScoped
        ? (command || toolName)
        : (typeof args.file_path === 'string' ? args.file_path
          : typeof args.path === 'string' ? args.path
          : typeof args.url === 'string' ? args.url
          : toolName)

  const isCommand = isCommandScoped || promptReason === 'dangerous_command'

  const reasonTag =
    promptReason === 'sensitive_file' ? t('perm.sensitiveFile') :
    promptReason === 'dangerous_command' ? t('perm.dangerousCommand') :
    promptReason === 'browser_action' ? t('perm.browserAction') :
    promptReason === 'path_access' ? t('perm.pathAccess') :
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
            {isPathAccess ? t('perm.pathAccessTitle') : isCommand ? t('perm.allowCommand') : t('perm.allowAction')}
          </Text>
        </Flex>

        {/* Atribuição: com multi-agentes o user tem de saber QUEM pergunta —
            pedidos de tarefas paralelas identificam a tarefa de origem. */}
        {originLabel && (
          <Flex align="center" gap={1.5} mb={2}>
            <Box
              w="6px"
              h="6px"
              borderRadius="full"
              bg={tokens.colors.status.warning}
              flexShrink={0}
            />
            <Text fontSize="11px" fontWeight={600} color={tokens.colors.status.warning} lineClamp={1}>
              {t('parallel.dialogFromTask').replace('{label}', originLabel)}
            </Text>
          </Flex>
        )}

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

        {/* Razão do classificador do Modo Auto — quando o diálogo surge por
            escalada, o developer vê AQUI porquê foi sinalizado (antes só ia
            para o log do chat). */}
        {classifierReason && (
          <Flex
            align="flex-start"
            gap={1.5}
            mb={3}
            px={2}
            py={1.5}
            borderRadius="6px"
            bg={tokens.colors.accent.orangeSubtle}
            border={`1px solid ${tokens.colors.accent.orangeMuted}`}
          >
            <Box as="span" color={tokens.colors.accent.orange} flexShrink={0} mt="1px" fontSize="10px" fontWeight={700}>
              {'⏵⏵'}
            </Box>
            <Text fontSize="11px" color={tokens.colors.text.secondary} lineHeight="1.4">
              <Text as="span" color={tokens.colors.accent.orange} fontWeight={600}>{t('perm.autoFlagged')}</Text>
              {' '}{classifierReason}
            </Text>
          </Flex>
        )}

        {/* Options */}
        <Flex direction="column" gap={1} mb={2}>
          <OptionRow
            index={1}
            label={isPathAccess ? t('perm.pathAccessSession') : t('perm.allowThisTime')}
            selected={selected === 'once'}
            onClick={() => { setSelected('once'); setShowReason(false) }}
          />
          {!hideAlways && (
            <>
              <OptionRow
                index={2}
                label={
                  isPathAccess
                    ? t('perm.pathAccessProject')
                    : isCommandScoped
                      ? t('perm.allowAlwaysPrefixProject')
                      : t('perm.allowAlwaysProject').replace('{tool}', toolName)
                }
                selected={selected === 'project'}
                onClick={() => { setSelected('project'); setShowReason(false) }}
              />
              {!isPathAccess && (
                <OptionRow
                  index={3}
                  label={
                    isCommandScoped
                      ? t('perm.allowAlwaysPrefixGlobal')
                      : t('perm.allowAlwaysGlobal').replace('{tool}', toolName)
                  }
                  selected={selected === 'global'}
                  onClick={() => { setSelected('global'); setShowReason(false) }}
                />
              )}
            </>
          )}
          <OptionRow
            index={hideAlways ? 2 : isPathAccess ? 3 : 4}
            label={t('perm.denyWithReason')}
            selected={selected === 'deny'}
            onClick={() => { setSelected('deny'); setShowReason(true) }}
          />
        </Flex>

        {/* Campo de prefixo editável — só para comandos, quando "sempre" está
            escolhido. O user pode estreitar/alargar o grant (paridade claude-vaz:
            campo de prefixo editável no diálogo de Bash). */}
        {isCommandScoped && canGrantAlways && (selected === 'project' || selected === 'global') && (
          <Box mb={2}>
            <Text fontSize="10px" color={tokens.colors.text.disabled} mb={1}>
              {t('perm.prefixLabel')}
            </Text>
            <Input
              value={prefixDraft}
              onChange={e => setPrefixDraft(e.target.value)}
              size="xs"
              fontSize="12px"
              fontFamily="mono"
              bg="rgba(0,0,0,0.3)"
              border="1px solid"
              borderColor="rgba(255,255,255,0.06)"
              borderRadius="6px"
              color={tokens.colors.text.primary}
              _focus={{ borderColor: tokens.colors.accent.purple, boxShadow: 'none' }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
            />
            <Text fontSize="10px" color={tokens.colors.text.disabled} mt={1}>
              {t('perm.prefixHint')}
            </Text>
          </Box>
        )}

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

        {/* Descoberta do Modo Auto no ponto de fricção: quando OFF, um link
            discreto liga-o (o pedido ATUAL continua manual — só os próximos
            passam pelo classificador). */}
        {!autoModePermissions && (
          <Box
            as="button"
            alignSelf="flex-start"
            fontSize="11px"
            color={tokens.colors.text.disabled}
            cursor="pointer"
            textAlign="left"
            _hover={{ color: tokens.colors.text.secondary }}
            onClick={() => setAutoModePermissions(true)}
          >
            {'⏵⏵ '}{t('perm.enableAutoMode')}
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
