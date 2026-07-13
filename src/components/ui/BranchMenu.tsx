/**
 * BranchMenu — chip de branch no header (ponto 5 do redesign 2026-07-13):
 * mostra a branch actual do projecto aberto e abre um dropdown para TROCAR
 * de branch ou CRIAR uma nova, sem sair do chat.
 *
 * Segurança: trocar/criar branch muda os ficheiros DEBAIXO de um run vivo —
 * com o agente ocupado pede confirmação primeiro. Erros do git (alterações
 * por commitar, nome inválido, …) sobem verbatim num toast: o stderr do git
 * é a melhor explicação que existe.
 */

import { useCallback, useEffect, useState } from 'react'
import { Box, Flex, Menu, Spinner, Text } from '@chakra-ui/react'
import { FiCheck, FiGitBranch, FiPlus } from 'react-icons/fi'
import { VscChevronDown } from 'react-icons/vsc'
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog'
import { invoke } from '@/utils/invokeMetrics'
import { useToastStore } from '@/stores/toastStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

interface GitBranchInfo {
  name: string
  current: boolean
}

async function confirmIfAgentBusy(): Promise<boolean> {
  try {
    const agentService = (await import('@/services/agent/agentService')).default.getInstance()
    if (!agentService.isAgentRunning()) return true
  } catch {
    return true
  }
  return tauriConfirm(t('branch.switchWhileRunning'), {
    title: t('project.agentBusyTitle'),
    kind: 'warning',
  })
}

function BranchMenu({ projectPath }: { projectPath: string }) {
  const [current, setCurrent] = useState<string | null>(null)
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshCurrent = useCallback(async () => {
    try {
      const branch = await invoke<string>('git_current_branch', { projectPath })
      setCurrent(branch)
    } catch {
      // Não é um repo git — o chip simplesmente não aparece.
      setCurrent(null)
    }
  }, [projectPath])

  useEffect(() => {
    setCurrent(null)
    void refreshCurrent()
  }, [refreshCurrent])

  const refreshBranches = useCallback(async () => {
    try {
      const list = await invoke<GitBranchInfo[]>('git_list_branches', { projectPath })
      setBranches(list)
    } catch {
      setBranches([])
    }
  }, [projectPath])

  const handleOpenChange = useCallback(
    (details: { open: boolean }) => {
      setMenuOpen(details.open)
      if (details.open) {
        setCreating(false)
        setNewName('')
        void refreshBranches()
        void refreshCurrent()
      }
    },
    [refreshBranches, refreshCurrent],
  )

  const switchTo = useCallback(
    async (branch: string) => {
      if (busy || branch === current) {
        setMenuOpen(false)
        return
      }
      if (!(await confirmIfAgentBusy())) return
      setBusy(true)
      try {
        await invoke('git_checkout_branch', { projectPath, branch })
        setCurrent(branch)
        useToastStore.getState().addToast('success', t('branch.switched').replace('{name}', branch))
        setMenuOpen(false)
      } catch (err) {
        useToastStore.getState().addToast('error', String(err))
      } finally {
        setBusy(false)
      }
    },
    [busy, current, projectPath],
  )

  const createBranch = useCallback(async () => {
    const branch = newName.trim()
    if (!branch || busy) return
    if (!(await confirmIfAgentBusy())) return
    setBusy(true)
    try {
      await invoke('git_create_branch', { projectPath, branch })
      setCurrent(branch)
      useToastStore.getState().addToast('success', t('branch.created').replace('{name}', branch))
      setMenuOpen(false)
      setCreating(false)
      setNewName('')
    } catch (err) {
      useToastStore.getState().addToast('error', String(err))
    } finally {
      setBusy(false)
    }
  }, [newName, busy, projectPath])

  if (!current) return null

  return (
    <Menu.Root open={menuOpen} onOpenChange={handleOpenChange}>
      <Menu.Trigger asChild>
        <Flex
          as="button"
          data-no-drag
          align="center"
          gap="6px"
          h="26px"
          px="9px"
          borderRadius="8px"
          bg="rgba(255, 255, 255, 0.05)"
          border={`1px solid ${tokens.colors.border.default}`}
          color={tokens.colors.text.secondary}
          cursor="pointer"
          maxW="220px"
          transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}`}
          _hover={{ bg: 'rgba(255, 255, 255, 0.08)', color: tokens.colors.text.primary }}
          title={t('branch.chipTitle')}
          aria-label={t('branch.chipTitle')}
        >
          {busy ? (
            <Spinner size="xs" color={tokens.colors.accent.primary} borderWidth="1.5px" />
          ) : (
            <FiGitBranch size={12} />
          )}
          <Text fontSize="12px" fontWeight="600" lineClamp={1} maxW="160px">
            {current}
          </Text>
          {busy ? null : <VscChevronDown size={11} />}
        </Flex>
      </Menu.Trigger>
      <Menu.Positioner className="no-drag" style={{ zIndex: 30000 }}>
        <Menu.Content
          className="no-drag"
          style={{ zIndex: 30000, minWidth: '260px', maxHeight: '340px', overflowY: 'auto' }}
          bg={tokens.colors.bg.app}
          border={`1px solid ${tokens.colors.border.subtle}`}
          borderRadius="10px"
          boxShadow={`0 16px 48px ${tokens.colors.bg.blackOverlayStrong}`}
        >
          <Box px={3} py={2} color={tokens.colors.text.muted} fontSize="11px" textTransform="uppercase" letterSpacing="0.08em">
            {t('branch.sectionTitle')}
          </Box>
          {branches.map(branch => (
            <Menu.Item
              value={branch.name}
              key={branch.name}
              disabled={busy}
              onClick={() => void switchTo(branch.name)}
              _hover={{ bg: tokens.colors.bg.hover }}
              opacity={busy ? 0.55 : 1}
            >
              <Flex align="center" gap={2} px={2} py="6px" width="100%">
                <Box w="14px" flexShrink={0} color={tokens.colors.accent.greenBright}>
                  {branch.current && !busy && <FiCheck size={13} />}
                  {busy && branch.name === current && (
                    <Spinner size="xs" color={tokens.colors.accent.primary} borderWidth="1.5px" />
                  )}
                </Box>
                <Text
                  fontSize="13px"
                  color={branch.current ? tokens.colors.text.primary : tokens.colors.text.secondary}
                  fontWeight={branch.current ? '650' : '450'}
                  lineClamp={1}
                >
                  {branch.name}
                </Text>
              </Flex>
            </Menu.Item>
          ))}
          <Box h="1px" bg={tokens.colors.border.subtle} mx={2} my={1} />
          {creating ? (
            // Linha de criação inline — Box simples (não Menu.Item) para o
            // clique/teclado não seleccionar nem fechar o menu.
            <Flex align="center" gap={2} px={3} py={2}>
              <FiGitBranch size={12} color={tokens.colors.text.muted} />
              <input
                autoFocus
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: 'rgba(255,255,255,0.05)',
                  border: `1px solid ${tokens.colors.border.default}`,
                  borderRadius: '6px',
                  padding: '0 8px',
                  height: '26px',
                  fontSize: '12px',
                  color: tokens.colors.text.primary,
                  outline: 'none',
                }}
                placeholder={t('branch.createPlaceholder')}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  e.stopPropagation()
                  if (e.key === 'Enter') void createBranch()
                  if (e.key === 'Escape') setCreating(false)
                }}
                onClick={e => e.stopPropagation()}
              />
              <Box
                as="button"
                px="8px"
                h="26px"
                borderRadius="6px"
                fontSize="11px"
                fontWeight="700"
                color={tokens.colors.text.inverse}
                bg={tokens.colors.accent.primary}
                opacity={newName.trim() && !busy ? 1 : 0.5}
                cursor={newName.trim() && !busy ? 'pointer' : 'default'}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation()
                  void createBranch()
                }}
              >
                {busy ? (
                  <Spinner size="xs" color={tokens.colors.text.inverse} borderWidth="1.5px" />
                ) : (
                  t('branch.createConfirm')
                )}
              </Box>
            </Flex>
          ) : (
            <Box
              px={3}
              py={2}
              cursor="pointer"
              display="flex"
              alignItems="center"
              gap={2}
              role="button"
              transition={`background ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.hover }}
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation()
                setCreating(true)
              }}
            >
              <FiPlus size={13} color={tokens.colors.text.secondary} />
              <Text fontSize="13px" color={tokens.colors.text.secondary}>
                {t('branch.create')}
              </Text>
            </Box>
          )}
        </Menu.Content>
      </Menu.Positioner>
    </Menu.Root>
  )
}

export default BranchMenu
