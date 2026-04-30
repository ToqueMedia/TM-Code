import { memo, useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react'
import { Box, Flex, Text, HStack, Portal } from '@chakra-ui/react'
import { FiLogOut, FiSettings, FiAlertCircle, FiLoader, FiUpload } from 'react-icons/fi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tokens } from '@/theme/tokens'
import { useProjectStore } from '../stores/projectStore'
import { useAgentStore } from '../stores/agentStore'
import { useAuthStore } from '../stores/authStore'
import { usePermissionStore } from '../stores/permissionStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useChatStore } from '../stores/chatStore'
import { useDeployStore } from '../stores/deployStore'
import FirebaseAuthService from '../services/auth/firebaseAuth'
import WindowControls from './ui/WindowControls'
import MenuBar from './ui/titlebar/MenuBar'
import PublishModal from './dialogs/PublishModal'
import { useTranslation } from '@/i18n'
import { IS_MAC } from '@/utils/platform'

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
  // Publish modal state lives in the layout store so the PreviewView toolbar
  // can open the same modal without needing a duplicate mount.
  const publishOpen = useLayoutStore(s => s.isPublishModalOpen)
  const avatarRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 })

  // Subscribed so the button flips to "Publishing…" + spinner while a deploy
  // is mid-flight. Without this the user can re-click and lose track of
  // progress (the modal already guards against double-deploy, but the visual
  // affordance matters across all view modes — chat, editor, preview).
  const isPublishing = useDeployStore(function (s) {
    const id = currentProject?.id
    if (!id) return false
    return s.records.get(id)?.phase === 'in_progress'
  })

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

  // Cmd/Ctrl+Shift+D — open the publish modal when a project is loaded.
  // Bound to MinimalTitleBar (always-mounted) so the shortcut works in every
  // view mode, not just the (now unused) full TitleBar.
  useEffect(function () {
    function onKey(e: KeyboardEvent) {
      const meta = IS_MAC ? e.metaKey : e.ctrlKey
      if (meta && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
        if (currentProject) {
          e.preventDefault()
          useLayoutStore.getState().setPublishModalOpen(true)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentProject])

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
    thinking: { color: tokens.colors.toolCall.runningText, label: t('titlebar.thinking') },
    generating: { color: tokens.colors.accent.primary, label: t('titlebar.generating') },
    applying: { color: tokens.colors.accent.purple, label: t('titlebar.applying') },
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
    // Respect the Tauri drag-region opt-out: any ancestor marked with
    // data-tauri-drag-region="false" (MenuBar items, user menu avatar, etc.)
    // should NOT start a window drag — otherwise the click gets eaten by
    // startDragging() on Windows and onClick never fires.
    if (t.closest?.('[data-tauri-drag-region="false"]')) return
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
      bg={tokens.colors.dialog.bg}
      borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
      display="flex"
      alignItems="center"
      px={2}
      position="relative"
      userSelect="none"
      backdropFilter="blur(10px)"
      flexShrink={0}
      data-tauri-drag-region
      onMouseDown={handleMouseDown}
    >
      {/* Left: Window controls (macOS) + menus */}
      <HStack gap={2} flexShrink={0} pl={1} data-tauri-drag-region="false">
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

      {/* Right: Publish + Agent status + User identity */}
      <HStack gap={3} flexShrink={0} pr={1} data-tauri-drag-region="false">
        {/* Publish button — visible whenever a project is open, in any view
            mode (chat, editor, preview). Position-of-emphasis at the start
            of the right cluster. */}
        {currentProject && (
          <Box
            as="button"
            display="flex"
            alignItems="center"
            gap="6px"
            h="24px"
            px="10px"
            borderRadius="6px"
            bg={tokens.colors.accent.primarySubtle}
            color={tokens.colors.accent.primary}
            border={`1px solid ${tokens.colors.accent.primaryMuted}`}
            fontSize="11px"
            fontWeight="500"
            cursor="pointer"
            transition={tokens.transition.fast}
            _hover={{
              bg: tokens.colors.accent.primaryHover,
              boxShadow: `0 2px 12px -2px ${tokens.colors.accent.primaryGlow}`,
            }}
            onClick={function () { useLayoutStore.getState().setPublishModalOpen(true) }}
            title={isPublishing
              ? 'Publishing… click to view progress'
              : `Publish (${IS_MAC ? '⌘' : 'Ctrl'}⇧D)`}
          >
            {isPublishing ? (
              <Box
                css={{
                  animation: 'tm-publish-spin 1.4s linear infinite',
                  '@keyframes tm-publish-spin': {
                    from: { transform: 'rotate(0deg)' },
                    to: { transform: 'rotate(360deg)' },
                  },
                }}
              >
                <FiLoader size={11} />
              </Box>
            ) : (
              <FiUpload size={11} />
            )}
            <Text fontSize="11px" fontWeight="500">
              {isPublishing ? 'Publishing…' : 'Publish'}
            </Text>
          </Box>
        )}

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
        <HStack flexShrink={0} data-tauri-drag-region="false">
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
          onClose={() => setShowIssueReporter(false)}
        />
      </Suspense>

      {/* Publish modal — controlled by the Publish button above and the
          Cmd/Ctrl+Shift+D shortcut. Mounted here so it survives view mode
          changes (chat → preview → editor) without unmounting mid-deploy. */}
      <PublishModal isOpen={publishOpen} onClose={function () { useLayoutStore.getState().setPublishModalOpen(false) }} />
    </Box>
  )
}

export default memo(MinimalTitleBar)
