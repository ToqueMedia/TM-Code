/**
 * Titlebar attention bell — shows when ANY agent in this process needs the
 * developer (permissions, questions, credentials, finished tasks), including
 * when the request belongs to a project that is not currently focused.
 */

import { useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiBell, FiCheck, FiKey, FiHelpCircle, FiLock, FiAlertCircle } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { useProjectStore } from '@/stores/projectStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useAttentionInbox, type AttentionItem, type AttentionKind } from '@/hooks/useAttentionInbox'
import { openParallelTaskChat } from '@/hooks/useParallelTaskRows'

const KIND_ICON: Record<AttentionKind, React.ReactNode> = {
  permission: <FiLock size={12} />,
  question: <FiHelpCircle size={12} />,
  credentials: <FiKey size={12} />,
  task_done: <FiCheck size={12} />,
  task_error: <FiAlertCircle size={12} />,
}

const KIND_COLOR: Record<AttentionKind, string> = {
  permission: tokens.colors.status.warning,
  question: tokens.colors.status.warning,
  credentials: tokens.colors.status.warning,
  task_done: tokens.colors.status.running,
  task_error: tokens.colors.status.error,
}

function kindLabel(kind: AttentionKind): string {
  switch (kind) {
    case 'permission': return t('parallel.authNeeded')
    case 'question': return t('parallel.questionNeeded')
    case 'credentials': return t('parallel.credentialsNeeded')
    case 'task_done': return t('welcome.agentDone')
    case 'task_error': return t('welcome.agentError')
  }
}

async function navigateToAttentionItem(item: AttentionItem, focusedPath: string | undefined): Promise<void> {
  const targetPath = item.projectPath
  const needsSwitch = !!(targetPath && focusedPath && targetPath !== focusedPath)

  if (needsSwitch && targetPath) {
    await useProjectStore.getState().openProject(targetPath)
  }

  if (item.sessionId && targetPath) {
    await openParallelTaskChat(targetPath, item.sessionId)
    return
  }

  // Main-run / focused-project interactive prompt — dialog lives in chat.
  useLayoutStore.getState().setViewMode('chat')
}

export default function AttentionInbox() {
  const items = useAttentionInbox()
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (items.length === 0) setOpen(false)
  }, [items.length])

  // Show the bell whenever there is attention work — even if no project is
  // focused (edge) or the request is for a different project in the workspace.
  if (items.length === 0) return null

  const interactive = items.filter(i => i.kind !== 'task_done' && i.kind !== 'task_error').length
  // Cross-project auth: at least one interactive item belongs to another path.
  const foreignAuth = items.some(
    i =>
      (i.kind === 'permission' || i.kind === 'question' || i.kind === 'credentials')
      && i.projectPath
      && projectPath
      && i.projectPath !== projectPath,
  )

  return (
    <Box position="relative" ref={panelRef} data-no-drag>
      <Flex
        as="button"
        align="center"
        gap="6px"
        h="26px"
        px="9px"
        borderRadius="8px"
        bg={foreignAuth ? 'rgba(210, 153, 34, 0.12)' : 'rgba(255, 255, 255, 0.05)'}
        border={`1px solid ${foreignAuth ? 'rgba(210, 153, 34, 0.35)' : tokens.colors.border.default}`}
        color={interactive > 0 ? tokens.colors.status.warning : tokens.colors.text.secondary}
        cursor="pointer"
        title={foreignAuth ? t('inbox.tooltipOtherProject') : t('inbox.tooltip')}
        aria-label={foreignAuth ? t('inbox.tooltipOtherProject') : t('inbox.tooltip')}
        _hover={{ bg: foreignAuth ? 'rgba(210, 153, 34, 0.18)' : 'rgba(255,255,255,0.08)' }}
        onClick={() => setOpen(prev => !prev)}
        css={interactive > 0 ? {
          '@keyframes tmInboxPulse': {
            '0%, 100%': { opacity: 1 },
            '50%': { opacity: 0.55 },
          },
          '& [data-inbox-bell]': { animation: 'tmInboxPulse 1.4s ease-in-out infinite' },
        } : undefined}
      >
        <Box as="span" data-inbox-bell display="flex" alignItems="center" flexShrink={0}>
          <FiBell size={12} />
        </Box>
        <Text fontSize="11px" fontWeight="700" fontFamily={tokens.fontFamily.mono}>
          {items.length}
        </Text>
      </Flex>

      {open && (
        <Box
          position="absolute"
          top="32px"
          right={0}
          minW="300px"
          maxW="380px"
          bg={tokens.colors.bg.app}
          border={`1px solid ${tokens.colors.border.subtle}`}
          borderRadius="10px"
          boxShadow="0 16px 48px rgba(0,0,0,0.5)"
          zIndex={30000}
          py={1}
        >
          <Text px={3} py={2} fontSize="10px" fontWeight="700" letterSpacing="0.08em" textTransform="uppercase" color={tokens.colors.text.muted}>
            {t('inbox.title')}
          </Text>
          {items.map(item => {
            const otherProject =
              !!(item.projectPath && projectPath && item.projectPath !== projectPath)
            return (
              <Flex
                key={item.id}
                as="button"
                align="center"
                gap={2}
                w="100%"
                px={3}
                py="7px"
                textAlign="left"
                _hover={{ bg: tokens.colors.bg.hover }}
                onClick={() => {
                  setOpen(false)
                  void navigateToAttentionItem(item, projectPath)
                }}
              >
                <Box as="span" color={KIND_COLOR[item.kind]} display="flex" flexShrink={0}>
                  {KIND_ICON[item.kind]}
                </Box>
                <Box flex={1} minW={0}>
                  {(item.projectName || otherProject) && (
                    <Text fontSize="10px" fontWeight="600" color={tokens.colors.text.muted} lineClamp={1}>
                      {item.projectName || t('parallel.unknownProject')}
                      {otherProject ? ` · ${t('inbox.otherProject')}` : ''}
                    </Text>
                  )}
                  <Text fontSize="12px" color={tokens.colors.text.primary} lineClamp={1}>
                    {item.label}
                  </Text>
                </Box>
                <Text fontSize="9px" color={KIND_COLOR[item.kind]} flexShrink={0} textTransform="uppercase" letterSpacing="0.04em">
                  {kindLabel(item.kind)}
                </Text>
              </Flex>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
