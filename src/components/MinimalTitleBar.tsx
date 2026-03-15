import { memo, useState, useRef, useEffect } from 'react'
import { Box, Flex, Text, HStack } from '@chakra-ui/react'
import { FiLogOut } from 'react-icons/fi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tokens } from '@/theme/tokens'
import { useProjectStore } from '../stores/projectStore'
import { useAgentStore } from '../stores/agentStore'
import { useAuthStore } from '../stores/authStore'
import { usePermissionStore } from '../stores/permissionStore'
import FirebaseAuthService from '../services/auth/firebaseAuth'
import WindowControls from './ui/WindowControls'

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
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!showUserMenu) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showUserMenu])

  const statusConfig: Record<string, { color: string; label: string }> = {
    idle: { color: tokens.colors.accent.green, label: 'Ready' },
    thinking: { color: tokens.colors.toolCall.runningText, label: 'Thinking...' },
    generating: { color: tokens.colors.accent.primary, label: 'Generating...' },
    applying: { color: tokens.colors.accent.purple, label: 'Applying...' },
    error: { color: tokens.colors.accent.red, label: 'Error' },
  }

  const config = hasPendingPermission
    ? { color: tokens.colors.toolCall.runningText, label: 'Awaiting permission...' }
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

  async function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    const tag = t.tagName?.toLowerCase() || ''
    if (['button', 'input', 'svg', 'path'].includes(tag)) return
    if (t.getAttribute?.('role') === 'button') return
    try { await getCurrentWindow().startDragging() } catch (e) { console.error('Drag start failed:', e) }
  }

  async function handleSignOut() {
    setShowUserMenu(false)
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
      {/* Left: Window controls */}
      <HStack gap={3} position="absolute" left={8}>
        <WindowControls
          onClose={handleClose}
          onMinimize={handleMinimize}
          onMaximize={handleFullToggle}
        />
      </HStack>

      {/* Center: App name + project */}
      <Flex
        flex={1}
        justify="center"
        align="center"
        gap={2}
      >
        <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
          ToqueMedia Studio
        </Text>
        {currentProject && (
          <>
            <Text fontSize="13px" color={tokens.colors.text.disabled}>—</Text>
            <Text fontSize="13px" color={tokens.colors.text.secondary}>
              {currentProject.name}
            </Text>
          </>
        )}
      </Flex>

      {/* Right: Agent status + User identity */}
      <HStack gap={3} position="absolute" right={12}>
        {/* Agent status */}
        <HStack gap={1.5}>
          <Box
            w="7px"
            h="7px"
            borderRadius="full"
            bg={config.color}
            boxShadow={`0 0 6px ${config.color}40`}
            animation={status !== 'idle' && status !== 'error' ? 'pulse 1.5s ease-in-out infinite' : undefined}
            css={status !== 'idle' && status !== 'error' ? {
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

        {/* User identity */}
        {user && (
          <Box position="relative" ref={menuRef}>
            <Flex
              align="center"
              gap={1.5}
              cursor="pointer"
              px={1.5}
              py={0.5}
              borderRadius="6px"
              transition={`background ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.whiteSubtle }}
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

            {/* Dropdown menu */}
            {showUserMenu && (
              <Box
                position="absolute"
                top="100%"
                right={0}
                mt={1}
                bg={tokens.colors.dialog.bg}
                border={`1px solid ${tokens.colors.border.panel}`}
                borderRadius="8px"
                boxShadow="0 4px 12px rgba(0,0,0,0.3)"
                py={1}
                minW="200px"
                zIndex={100}
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
                  transition={`background ${tokens.transition.fast}`}
                  _hover={{ bg: tokens.colors.bg.whiteSubtle }}
                  onClick={handleSignOut}
                >
                  <FiLogOut size={13} color={tokens.colors.text.secondary} />
                  <Text fontSize="12px" color={tokens.colors.text.secondary}>
                    Sign Out
                  </Text>
                </Box>
              </Box>
            )}
          </Box>
        )}
      </HStack>
    </Box>
  )
}

export default memo(MinimalTitleBar)
