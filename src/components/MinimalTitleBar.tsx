import { memo, useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react'
import { Box, Flex, Text, HStack, Portal } from '@chakra-ui/react'
import { FiLogOut, FiSettings, FiAlertCircle, FiUploadCloud } from 'react-icons/fi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tokens } from '@/theme/tokens'
import { useProjectStore } from '../stores/projectStore'
import { useAuthStore } from '../stores/authStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useToastStore } from '../stores/toastStore'
import FirebaseAuthService from '../services/auth/firebaseAuth'
import { prepareProjectWebExport, sendProjectToTmCodeWeb, type PreparedWebExport } from '../services/webExportService'
import WindowControls from './ui/WindowControls'
import MenuBar from './ui/titlebar/MenuBar'
import { BrowserMissingDialog } from './dialogs/BrowserMissingDialog'
import { useTranslation, t as translate } from '@/i18n'
import { IS_MAC, IS_LINUX } from '@/utils/platform'

const IssueReporterDialog = lazy(() => import('./dialogs/IssueReporterDialog'))

function getInitials(email: string | null, displayName: string | null): string {
  if (displayName) {
    const parts = displayName.trim().split(/\s+/)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase()
    }
    return parts[0].substring(0, 2).toUpperCase()
  }
  if (email) {
    const local = email.split('@')[0]
    const parts = local.split(/[._-]/)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase()
    }
    return local.substring(0, 2).toUpperCase()
  }
  return '?'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

function buildSendToWebConfirmMessage(template: string, prepared: PreparedWebExport): string {
  const summary = prepared.summary
  const skipped = summary.skippedGenerated +
    summary.skippedHidden +
    summary.skippedSensitive +
    summary.skippedUnsupported
  const base = template
    .replace('{files}', String(summary.fileCount))
    .replace('{size}', formatBytes(summary.totalBytes))
    .replace('{skipped}', String(skipped))

  // Only curated, translated, plain-language notes here — the raw
  // compatibility warnings are developer-facing and stay in the payload.
  const extras: string[] = []
  const compatibility = prepared.payload.compatibility
  if (compatibility.hasDatabase) extras.push(`• ${translate('titlebar.sendToWebDbNote')}`)
  extras.push(`• ${translate('titlebar.sendToWebEnvNote')}`)
  if (summary.assetCount > 0) {
    extras.push(`• ${translate('titlebar.sendToWebAssetsNote').replace('{assets}', String(summary.assetCount))}`)
  }

  return extras.length > 0 ? `${base}\n\n${extras.join('\n')}` : base
}

function MinimalTitleBar() {
  const currentProject = useProjectStore(s => s.currentProject)
  const user = useAuthStore(s => s.user)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showIssueReporter, setShowIssueReporter] = useState(false)
  const [sendingToWeb, setSendingToWeb] = useState(false)
  // Painel de atividade do "Enviar para Web" — lista de passos com o atual
  // em spinner e os concluídos com ✓.
  const [exportSteps, setExportSteps] = useState<Array<{ label: string; done: boolean }>>([])
  const exportStepsClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleCloseIssueReporter = useCallback(() => setShowIssueReporter(false), [])
  const avatarRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 })

  // Position the dropdown relative to the avatar (recalculate on resize)
  const recalcMenuPos = useCallback(() => {
    if (!avatarRef.current) return
    const rect = avatarRef.current.getBoundingClientRect()
    setMenuPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    })
  }, [])

  useEffect(() => {
    if (!showUserMenu) return
    recalcMenuPos()
    window.addEventListener('resize', recalcMenuPos)
    return () => window.removeEventListener('resize', recalcMenuPos)
  }, [showUserMenu, recalcMenuPos])

  // Listen for issue reporter open event (from native menu or elsewhere)
  useEffect(() => {
    function handleOpen() { setShowIssueReporter(true) }
    window.addEventListener('app:report-issue', handleOpen)
    return () => window.removeEventListener('app:report-issue', handleOpen)
  }, [])

  // Close menu on outside click
  useEffect(() => {
    if (!showUserMenu) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (
        avatarRef.current && !avatarRef.current.contains(target) &&
        menuRef.current && !menuRef.current.contains(target)
      ) {
        setShowUserMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showUserMenu])

  const t = useTranslation()

  async function handleClose() {
    try { await getCurrentWindow().close() } catch (e) { console.error('Window close failed:', e) }
  }

  async function handleMinimize() {
    try { await getCurrentWindow().minimize() } catch (e) { console.error('Window minimize failed:', e) }
  }

  async function handleFullToggle() {
    try {
      const win = getCurrentWindow()
      const plat = navigator.platform || ''
      if (/Mac/.test(plat)) {
        const fs = await win.isFullscreen()
        await win.setFullscreen(!fs)
      } else {
        const isMax = await win.isMaximized()
        if (isMax) await win.unmaximize()
        else await win.maximize()
      }
    } catch (e) { console.error('Window toggle failed:', e) }
  }

  const handleDoubleClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    const tag = t.tagName?.toLowerCase() || ''
    if (['button', 'input', 'svg', 'path'].includes(tag)) return
    if (t.getAttribute?.('role') === 'button') return
    if (t.closest?.('[data-no-drag]')) return
    if (avatarRef.current?.contains(t)) return
    try {
      const win = getCurrentWindow()
      const isMax = await win.isMaximized()
      if (isMax) await win.unmaximize()
      else await win.maximize()
    } catch (err) { console.error('Window toggle failed:', err) }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    const tag = t.tagName?.toLowerCase() || ''
    if (['button', 'input', 'svg', 'path'].includes(tag)) return
    if (t.getAttribute?.('role') === 'button') return
    // Respect our drag opt-out. Avoid data-tauri-drag-region="false":
    // on Windows the native drag handler keys off attribute presence.
    // should NOT start a window drag — otherwise the click gets eaten by
    // startDragging() on Windows and onClick never fires.
    if (t.closest?.('[data-no-drag]')) return
    // Don't start dragging if clicking inside user menu area
    if (avatarRef.current?.contains(t)) return
    getCurrentWindow().startDragging().catch(() => {})
  }, [])

  async function handleSignOut() {
    setShowUserMenu(false)

    // Close the project first — closeProject saves the chat session itself
    // (cleanupOnExit) and can DECLINE when the agent is mid-task and the
    // user picks "keep working". Without checking the result, sign-out
    // proceeded anyway: signed-out UI over an open workspace, with the
    // live run dying on the next token refresh.
    const project = useProjectStore.getState().currentProject
    if (project) {
      const closed = await useProjectStore.getState().closeProject().catch(() => false)
      if (!closed) return
    }

    // Clear auth state and sign out
    useAuthStore.getState().clear()
    await FirebaseAuthService.getInstance().signOut()
  }

  function handleOpenSettings() {
    setShowUserMenu(false)
    const project = useProjectStore.getState()
    if (!project.currentProject) {
      project.setWelcomeScreen(project.welcomeScreen === 'settings' ? 'hero' : 'settings')
      return
    }

    const layout = useLayoutStore.getState()
    if (layout.viewMode === 'settings') {
      layout.goBack()
    } else {
      layout.setViewMode('settings')
    }
  }

  // Activity feed do envio — cada passo aparece no painel flutuante enquanto
  // decorre (spinner) e fica com ✓ quando o seguinte começa. Substitui os
  // toasts intermédios: o developer vê a sequência inteira num só sítio.
  function pushExportStep(label: string) {
    setExportSteps(steps => [...steps.map(step => ({ ...step, done: true })), { label, done: false }])
  }
  function finishExportSteps(clearAfterMs: number) {
    setExportSteps(steps => steps.map(step => ({ ...step, done: true })))
    if (exportStepsClearTimer.current) clearTimeout(exportStepsClearTimer.current)
    exportStepsClearTimer.current = setTimeout(() => setExportSteps([]), clearAfterMs)
  }

  async function handleSendToWeb() {
    if (!currentProject || sendingToWeb) return
    setSendingToWeb(true)
    if (exportStepsClearTimer.current) clearTimeout(exportStepsClearTimer.current)
    setExportSteps([{ label: t('titlebar.sendToWebPreparing'), done: false }])
    try {
      const prepared = await prepareProjectWebExport(currentProject)
      // Fail-closed confirmation. window.confirm is NOT safe here: with the
      // Tauri dialog plugin it becomes async, and on an outdated binary the
      // command rejects ("dialog.confirm not allowed") — the old code then
      // treated the pending Promise as truthy and exported WITHOUT any
      // confirmation. Any failure to show the dialog must abort the send.
      let confirmed = false
      try {
        const { confirm: tauriConfirm } = await import('@tauri-apps/plugin-dialog')
        confirmed = await tauriConfirm(
          buildSendToWebConfirmMessage(t('titlebar.sendToWebConfirm'), prepared),
          { title: t('titlebar.sendToWebTitle'), kind: 'info' },
        )
      } catch {
        useToastStore.getState().addToast('error', t('titlebar.sendToWebConfirmFailed'))
        setExportSteps([])
        return
      }
      if (!confirmed) {
        setExportSteps([])
        return
      }

      const result = await sendProjectToTmCodeWeb(currentProject, prepared, progress => {
        if (progress.phase === 'provision-db') {
          pushExportStep(t('titlebar.sendToWebProvisioningDb'))
        } else if (progress.phase === 'db-ready') {
          pushExportStep(t('titlebar.sendToWebDbReady')
            .replace('{reused}', progress.reused ? t('titlebar.sendToWebDbReused') : t('titlebar.sendToWebDbCreated')))
        } else if (progress.phase === 'db-migrated') {
          pushExportStep(t('titlebar.sendToWebDbMigrated'))
        } else if (progress.phase === 'db-data-start') {
          pushExportStep(t('titlebar.sendToWebDbDataCopying'))
        } else if (progress.phase === 'db-data') {
          pushExportStep(progress.rows > 0
            ? t('titlebar.sendToWebDbDataDone').replace('{rows}', String(progress.rows))
            : t('titlebar.sendToWebDbDataNone'))
        } else if (progress.phase === 'db-verified') {
          pushExportStep(t('titlebar.sendToWebDbVerified'))
        } else if (progress.phase === 'db-linked') {
          pushExportStep(t('titlebar.sendToWebDbLinked'))
        } else if (progress.phase === 'uploading') {
          pushExportStep(progress.envVarCount > 0
            ? t('titlebar.sendToWebUploadingWithEnv')
            : t('titlebar.sendToWebUploading'))
        }
      })
      pushExportStep(t('titlebar.sendToWebSent'))
      finishExportSteps(3000)
      useToastStore.getState().addToast('success', t('titlebar.sendToWebSent'))
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(result.webUrl)
    } catch (error) {
      setExportSteps([])
      useToastStore.getState().addToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setSendingToWeb(false)
    }
  }

  const initials = user ? getInitials(user.email, user.displayName) : ''
  const displayName = user?.displayName?.trim() || user?.email?.split('@')[0] || ''
  const titlebarName = displayName
    ? (displayName.length > 24 ? displayName.substring(0, 22) + '...' : displayName)
    : ''

  return (
    <Box
      height="35px"
      // Translucent over the native NSVisualEffectView (macOS) / Mica/Acrylic
      // (Windows) installed by lib.rs::run().setup. Linux has no platform
      // vibrancy via window-vibrancy, so we keep the previous CSS backdrop
      // blur there — it's not equivalent to native, but better than a flat bar.
      bg={IS_MAC ? 'rgba(15, 15, 15, 0.55)' : tokens.colors.dialog.bg}
      backdropFilter={IS_LINUX ? 'blur(10px)' : undefined}
      borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
      display="flex"
      alignItems="center"
      px={2}
      position="relative"
      userSelect="none"
      flexShrink={0}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    >
      {/* Left: Window controls (macOS) + menus */}
      <HStack gap={2} flexShrink={0} pl={1} data-no-drag>
        {IS_MAC && (
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        )}
        <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary} whiteSpace="nowrap">
          TM Code
        </Text>
        {currentProject && (
          <>
            <Text fontSize="13px" color={tokens.colors.text.disabled}>—</Text>
            <Text fontSize="13px" color={tokens.colors.text.secondary} whiteSpace="nowrap" maxW="120px" overflow="hidden" textOverflow="ellipsis">
              {currentProject.name}
            </Text>
          </>
        )}
        <MenuBar />
      </HStack>

      {/* Center spacer */}
      <Flex flex={1} />

      {/* Right: project actions + User identity. */}
      <HStack gap={2} flexShrink={0} pr={1} data-no-drag>
        {/* Send to TM Code Web */}
        {currentProject && (
          <Flex
            as="button"
            align="center"
            justify="center"
            gap="7px"
            px="10px"
            h="28px"
            minW="28px"
            borderRadius="9px"
            cursor={sendingToWeb ? 'progress' : 'pointer'}
            color={sendingToWeb ? tokens.colors.accent.primary : tokens.colors.text.primary}
            bg={sendingToWeb ? 'rgba(254, 16, 99, 0.12)' : 'rgba(254, 16, 99, 0.075)'}
            border={sendingToWeb ? '1px solid rgba(254, 16, 99, 0.35)' : '1px solid rgba(254, 16, 99, 0.24)'}
            boxShadow={sendingToWeb ? '0 0 0 1px rgba(254,16,99,0.06), 0 8px 22px rgba(254,16,99,0.12)' : '0 0 0 1px rgba(254,16,99,0.03)'}
            transition="background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease"
            _hover={{
              bg: 'rgba(254, 16, 99, 0.13)',
              color: tokens.colors.text.inverse,
              borderColor: 'rgba(254, 16, 99, 0.42)',
              boxShadow: '0 10px 26px rgba(254,16,99,0.16), 0 0 0 1px rgba(254,16,99,0.06)',
              transform: sendingToWeb ? 'none' : 'translateY(-1px)',
            }}
            _active={{ transform: 'translateY(0) scale(0.98)' }}
            _focusVisible={{ outline: '2px solid rgba(254, 16, 99, 0.45)', outlineOffset: '2px' }}
            title={t('titlebar.sendToWebTitle')}
            aria-label={t('titlebar.sendToWebTitle')}
            aria-disabled={sendingToWeb}
            opacity={sendingToWeb ? 0.82 : 1}
            onClick={handleSendToWeb}
            css={{
              '@media (max-width: 860px)': {
                '& [data-send-web-label]': { display: 'none' },
              },
              '@keyframes tmSendToWebSpin': {
                to: { transform: 'rotate(360deg)' },
              },
            }}
          >
            <Box
              as="span"
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
              color="currentColor"
              css={sendingToWeb ? { animation: 'tmSendToWebSpin 0.9s linear infinite' } : undefined}
            >
              <FiUploadCloud size={14} />
            </Box>
            <Text data-send-web-label fontSize="11px" fontWeight="700" whiteSpace="nowrap">
              {t('titlebar.sendToWebShort')}
            </Text>
          </Flex>
        )}

        {user && (
          <Flex
            align="center"
            justify="center"
            w="28px"
            h="28px"
            borderRadius="6px"
            cursor="pointer"
            color={tokens.colors.text.secondary}
            transition={`all ${tokens.transition.fast}`}
            _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
            role="button"
            title={t('menu.settings')}
            aria-label={t('menu.settings')}
            onClick={handleOpenSettings}
          >
            <FiSettings size={14} />
          </Flex>
        )}

        {/* User identity */}
        {user && (
          <Box ref={avatarRef}>
            <Flex
              align="center"
              gap={1.5}
              cursor="pointer"
              px={1.5}
              py={0.5}
              borderRadius="6px"
              transition={`background ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.whiteSubtle }}
              role="button"
              onClick={() => setShowUserMenu(!showUserMenu)}
            >
              {/* Avatar with initials */}
              <Flex
                w="20px"
                h="20px"
                borderRadius="full"
                bg={tokens.colors.accent.primary}
                align="center"
                justify="center"
                flexShrink={0}
              >
                <Text fontSize="9px" fontWeight="700" color="#fff" lineHeight="1">
                  {initials}
                </Text>
              </Flex>
              <Text fontSize="11px" color={tokens.colors.text.secondary} maxW="130px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                {titlebarName}
              </Text>
            </Flex>
          </Box>
        )}
      </HStack>

      {/* Right: window controls (Windows/Linux) */}
      {!IS_MAC && (
        <HStack flexShrink={0} data-no-drag>
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        </HStack>
      )}

      {/* Dropdown rendered in portal to escape overflow:hidden */}
      {showUserMenu && user && (
        <Portal>
          <Box
            ref={menuRef}
            position="fixed"
            top={`${menuPos.top}px`}
            right={`${menuPos.right}px`}
            bg={tokens.colors.dialog.bg}
            border={`1px solid ${tokens.colors.border.panel}`}
            borderRadius="8px"
            boxShadow="0 4px 12px rgba(0,0,0,0.3)"
            py={1}
            minW="200px"
            zIndex={tokens.zIndex.overlay}
            backdropFilter="blur(16px)"
          >
            <Box px={3} py={2} borderBottom={`1px solid ${tokens.colors.border.panel}`}>
              <Text fontSize="12px" color={tokens.colors.text.primary} fontWeight="500">
                {displayName || t('activity.accounts')}
              </Text>
            </Box>
            <Box
              px={3}
              py={1.5}
              cursor="pointer"
              display="flex"
              alignItems="center"
              gap={2}
              role="button"
              transition={`background ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.whiteSubtle }}
              css={{ '& *': { pointerEvents: 'none' } }}
              onClick={handleOpenSettings}
            >
              <FiSettings size={13} color={tokens.colors.text.secondary} />
              <Text fontSize="12px" color={tokens.colors.text.secondary}>
                {t('menu.settings')}
              </Text>
            </Box>
            <Box
              px={3}
              py={1.5}
              cursor="pointer"
              display="flex"
              alignItems="center"
              gap={2}
              role="button"
              transition={`background ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.whiteSubtle }}
              // Children pointer-events:none so the WHOLE padded row is the click
              // target (matches ContextMenuOverlay). Without this, on Windows
              // WebView2 only a click directly on the icon/text registered.
              css={{ '& *': { pointerEvents: 'none' } }}
              onClick={() => {
                setShowUserMenu(false)
                setShowIssueReporter(true)
              }}
            >
              <FiAlertCircle size={13} color={tokens.colors.text.secondary} />
              <Text fontSize="12px" color={tokens.colors.text.secondary}>
                {t('issueReporter.menuItem')}
              </Text>
            </Box>
            <Box h="1px" bg={tokens.colors.border.panel} mx={2} my={0.5} />
            <Box
              px={3}
              py={1.5}
              cursor="pointer"
              display="flex"
              alignItems="center"
              gap={2}
              role="button"
              transition={`background ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.whiteSubtle }}
              css={{ '& *': { pointerEvents: 'none' } }}
              onClick={handleSignOut}
            >
              <FiLogOut size={13} color={tokens.colors.text.secondary} />
              <Text fontSize="12px" color={tokens.colors.text.secondary}>
                {t('common.signOut')}
              </Text>
            </Box>
          </Box>
        </Portal>
      )}
      {/* Issue Reporter Dialog */}
      <Suspense fallback={null}>
        <IssueReporterDialog
          isOpen={showIssueReporter}
          onClose={handleCloseIssueReporter}
        />
      </Suspense>

      {/* E2E: dialog mounted globally so any tool execution path can prompt
          the user, even from views where the preview is not yet visible. */}
      <BrowserMissingDialog />

      {/* Activity Loading do Enviar para Web — cada passo visível enquanto
          decorre; desaparece sozinho depois do envio concluir. */}
      {exportSteps.length > 0 && (
        <Portal>
          <Box
            position="fixed"
            bottom="16px"
            right="16px"
            zIndex={9999}
            minW="300px"
            maxW="380px"
            bg={tokens.colors.dialog.bg}
            border={`1px solid ${tokens.colors.border.panel}`}
            borderRadius="10px"
            boxShadow="0 12px 40px rgba(0,0,0,0.45)"
            px={4}
            py={3}
            css={{ '@keyframes tmExportStepSpin': { to: { transform: 'rotate(360deg)' } } }}
          >
            <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary} mb={2}>
              {t('titlebar.sendToWebShort')}
            </Text>
            <Flex direction="column" gap="6px">
              {exportSteps.map((step, index) => (
                <Flex key={index} align="flex-start" gap={2}>
                  {step.done ? (
                    <Text as="span" fontSize="12px" color={tokens.colors.accent.green} flexShrink={0} lineHeight="16px">✓</Text>
                  ) : (
                    <Box
                      w="10px"
                      h="10px"
                      mt="3px"
                      flexShrink={0}
                      borderRadius="full"
                      border="2px solid transparent"
                      borderTopColor={tokens.colors.accent.primary}
                      borderRightColor={tokens.colors.accent.primary}
                      // will-change promove a animação ao compositor: continua
                      // a rodar mesmo quando o main thread está ocupado (era o
                      // "spinner preso" que parecia um crash).
                      css={{ animation: 'tmExportStepSpin 0.8s linear infinite', willChange: 'transform' }}
                    />
                  )}
                  <Text
                    fontSize="12px"
                    lineHeight="16px"
                    color={step.done ? tokens.colors.text.secondary : tokens.colors.text.primary}
                  >
                    {step.label}
                  </Text>
                </Flex>
              ))}
            </Flex>
          </Box>
        </Portal>
      )}
    </Box>
  )
}

export default memo(MinimalTitleBar)
