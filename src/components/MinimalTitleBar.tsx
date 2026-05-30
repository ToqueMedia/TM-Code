import { memo, useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react'
import { Box, Flex, Text, HStack, Portal } from '@chakra-ui/react'
import { FiLogOut, FiSettings, FiAlertCircle } from 'react-icons/fi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tokens } from '@/theme/tokens'
import { useProjectStore } from '../stores/projectStore'
import { useAgentStore } from '../stores/agentStore'
import { useAuthStore } from '../stores/authStore'
import { usePermissionStore } from '../stores/permissionStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useChatStore } from '../stores/chatStore'
import FirebaseAuthService from '../services/auth/firebaseAuth'
import WindowControls from './ui/WindowControls'
import MenuBar from './ui/titlebar/MenuBar'
import { BrowserMissingDialog } from './dialogs/BrowserMissingDialog'
import { useTranslation } from '@/i18n'
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

function MinimalTitleBar() {
  const currentProject = useProjectStore(s => s.currentProject)
  const status = useAgentStore(s => s.status)
  const user = useAuthStore(s => s.user)
  const hasPendingPermission = usePermissionStore(s => !!s.pendingPermission)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showIssueReporter, setShowIssueReporter] = useState(false)
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

  const statusConfig: Record<string, { color: string; label: string }> = {
    idle: { color: tokens.colors.accent.green, label: t('titlebar.ready') },
    awaiting_response: { color: tokens.colors.toolCall.runningText, label: t('titlebar.awaitingResponse') },
    reasoning: { color: tokens.colors.accent.purple, label: t('titlebar.reasoning') },
    generating: { color: tokens.colors.accent.primary, label: t('titlebar.generating') },
    applying: { color: tokens.colors.accent.purple, label: t('titlebar.applying') },
    compressing: { color: tokens.colors.accent.orange, label: t('titlebar.compressing') },
    error: { color: tokens.colors.accent.red, label: t('titlebar.error') },
  }

  const config = hasPendingPermission
    ? { color: tokens.colors.toolCall.runningText, label: t('titlebar.awaitingPermission') }
    : (statusConfig[status] || statusConfig.idle)

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

    // Clean up project and chat state before signing out
    const project = useProjectStore.getState().currentProject
    if (project) {
      await useChatStore.getState().cleanupOnExit(project.path).catch(() => {})
      await useProjectStore.getState().closeProject().catch(() => {})
    }

    // Clear auth state and sign out
    useAuthStore.getState().clear()
    await FirebaseAuthService.getInstance().signOut()
  }

  const initials = user ? getInitials(user.email, user.displayName) : ''
  const displayEmail = user?.email
    ? (user.email.length > 24 ? user.email.substring(0, 22) + '...' : user.email)
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

      {/* Right: Agent status + User identity. The Publish button still lives
          in the PreviewView toolbar and the Cmd/Ctrl+Shift+D shortcut keeps
          working — both routes open the same modal via layoutStore. */}
      <HStack gap={3} flexShrink={0} pr={1} data-no-drag>
        {/* Agent status */}
        <HStack gap={1.5}>
          <Box
            w="7px"
            h="7px"
            borderRadius="full"
            bg={config.color}
            boxShadow={`0 0 6px ${config.color}40`}
            css={status !== 'idle' && status !== 'error' ? {
              animation: 'pulse 1.5s ease-in-out infinite',
              '@keyframes pulse': {
                '0%, 100%': { opacity: 1 },
                '50%': { opacity: 0.4 },
              }
            } : undefined}
          />
          <Text fontSize="11px" color={tokens.colors.text.secondary}>
            {config.label}
          </Text>
        </HStack>

        {/* Settings */}
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
          onClick={function () {
            const layout = useLayoutStore.getState()
            if (layout.viewMode === 'settings') {
              layout.goBack()
            } else {
              layout.setViewMode('settings')
            }
          }}
        >
          <FiSettings size={14} />
        </Flex>

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
              <Text fontSize="11px" color={tokens.colors.text.secondary}>
                {displayEmail}
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
                {user.displayName || user.email}
              </Text>
              {user.displayName && (
                <Text fontSize="11px" color={tokens.colors.text.secondary} mt={0.5}>
                  {user.email}
                </Text>
              )}
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
    </Box>
  )
}

export default memo(MinimalTitleBar)
