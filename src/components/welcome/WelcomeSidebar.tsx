import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Flex,
  Heading,
  Text,
  VStack,
  HStack,
  Icon,
} from '@chakra-ui/react'
import {
  LuFolderOpen,
  LuGitBranch,
  LuSettings,
  LuEraser,
  LuPlus,
  LuCheck,
  LuExternalLink,
  LuMessagesSquare,
  LuSquare,
  LuLoader,
} from 'react-icons/lu'
import { stopProjectAgent } from '@/services/agent/stopProjectAgent'
import { VscLayoutSidebarLeft, VscLayoutSidebarLeftOff } from 'react-icons/vsc'
import { FiAlertCircle, FiLogOut } from 'react-icons/fi'
import { getVersion } from '@tauri-apps/api/app'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { showProjectContextMenu } from '@/components/projectContextMenu'
import { useProjectAgentStatuses, type ProjectAgentStatus } from '@/hooks/useProjectAgentStatuses'
import { invoke } from '@/utils/invokeMetrics'
import { useAuthStore } from '@/stores/authStore'
import { useProjectStore } from '@/stores/projectStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { openMainSessionChat } from '@/hooks/useParallelTaskRows'
import { useBillingStore, isTeamCollabActive } from '@/stores/billingStore'
import { useCollabStore } from '@/stores/collabStore'
import { signOutWithGuard } from '@/services/auth/signOutFlow'
import type { RecentProject } from '@/types/project'

// Cache the version promise — it never changes during the session.
let versionPromise: Promise<string> | null = null
function getAppVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = getVersion()
      .then(v => `v${v}`)
      .catch(() => '')
  }
  return versionPromise
}

// ─── Time helpers ───────────────────────────────────────────────────────

/** Compact "2m / 3h / 5d" for agent status badges. */
function shortAgo(epochMs: number): string | null {
  const diff = Date.now() - epochMs
  if (!Number.isFinite(diff) || diff < 0) return null
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t('welcome.justNow')
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function getInitials(email: string | null, displayName: string | null): string {
  if (displayName) {
    const parts = displayName.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return parts[0].substring(0, 2).toUpperCase()
  }
  if (email) {
    const local = email.split('@')[0]
    const parts = local.split(/[._-]/)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return local.substring(0, 2).toUpperCase()
  }
  return '?'
}

const SIDEBAR_COLLAPSED_KEY = 'tm.welcomeSidebar.collapsed'
export const SIDEBAR_EXPANDED_W = 'clamp(200px, 30vw, 300px)'
export const SIDEBAR_COLLAPSED_W = 48

const railBtnProps = {
  display: 'flex' as const,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  w: '36px',
  h: '36px',
  borderRadius: '8px',
  color: tokens.colors.text.secondary,
  cursor: 'pointer' as const,
  flexShrink: 0,
  transition: `background ${tokens.transition.fast}, color ${tokens.transition.fast}`,
  _hover: { bg: 'rgba(255, 255, 255, 0.08)', color: tokens.colors.text.primary },
  _focusVisible: { outline: '2px solid rgba(254, 16, 99, 0.45)', outlineOffset: '1px' },
}

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

interface WelcomeSidebarProps {
  /** Projects in this window's workspace (stable order — not recents ranking). */
  recentProjects: RecentProject[]
  onNewProject: () => void
  onOpenFolder: () => void
  onCloneRepository: () => void
  onOpenProject: (path?: string) => void
  activeProjectPath?: string | null
  /** Clear the workspace project list. Caller handles confirmation. */
  onClearRecent?: () => void
  /** Notify parent so the outer motion shell can animate width. */
  onCollapsedChange?: (collapsed: boolean) => void
  /** Controlled collapse (parent owns persistence / shell width). Optional. */
  collapsed?: boolean
}

const WelcomeSidebar: React.FC<WelcomeSidebarProps> = ({
  recentProjects,
  onNewProject,
  onOpenFolder,
  onCloneRepository,
  onOpenProject,
  activeProjectPath,
  onClearRecent,
  onCollapsedChange,
  collapsed: collapsedProp,
}) => {
  const [appVersion, setAppVersion] = useState('')
  const [internalCollapsed, setInternalCollapsed] = useState(readSidebarCollapsed)
  const collapsed = collapsedProp ?? internalCollapsed

  const setCollapsed = useCallback((next: boolean) => {
    if (collapsedProp === undefined) setInternalCollapsed(next)
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
    } catch { /* private mode */ }
    onCollapsedChange?.(next)
  }, [collapsedProp, onCollapsedChange])

  useEffect(() => {
    onCollapsedChange?.(collapsed)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- mount sync only

  // Cross-window agent activity for every project in the list. Polling-based
  // on purpose: each window is a separate OS process, disk is the only
  // shared channel (see useProjectAgentStatuses).
  const agentStatuses = useProjectAgentStatuses(recentProjects.map(p => p.path))

  // Same-named projects at DIFFERENT paths (e.g. two "katondo-queue" folders)
  // are indistinguishable in the list — flag the collisions so each shows a
  // dimmed parent-folder hint. Only ambiguous names get the hint (no noise).
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of recentProjects) counts.set(p.name, (counts.get(p.name) ?? 0) + 1)
    return new Set(
      Array.from(counts.entries()).filter(([, n]) => n > 1).map(([name]) => name),
    )
  }, [recentProjects])

  // F3: asTask queue items no longer exist (one agent per project).

  useEffect(() => {
    getAppVersion().then(setAppVersion)
  }, [])

  const handleProjectContextMenu = useCallback((e: React.MouseEvent, project: RecentProject) => {
    e.preventDefault()
    e.stopPropagation()
    showProjectContextMenu(project).catch(() => {})
  }, [])

  const primaryActions = [
    { icon: LuPlus, label: t('welcome.newProject'), onClick: onNewProject },
    { icon: LuFolderOpen, label: t('welcome.openProject'), onClick: onOpenFolder },
    { icon: LuGitBranch, label: t('welcome.cloneRepo'), onClick: onCloneRepository },
  ] as const

  // ── Collapsed: pure activity-bar rail (no text, no overflow) ──────────
  if (collapsed) {
    return (
      <Box
        width={`${SIDEBAR_COLLAPSED_W}px`}
        minWidth={`${SIDEBAR_COLLAPSED_W}px`}
        maxWidth={`${SIDEBAR_COLLAPSED_W}px`}
        h="100%"
        minH={0}
        bg="rgba(15, 15, 15, 0.97)"
        borderRight="1px solid"
        borderColor="rgba(255, 255, 255, 0.06)"
        display="flex"
        flexDirection="column"
        alignItems="center"
        py={3}
        px={0}
        data-no-drag
        data-sidebar-collapsed="true"
        position="relative"
        overflow="hidden"
      >
        {/* Logo mark */}
        <Box
          width="26px"
          height="26px"
          mb={3}
          flexShrink={0}
          filter="drop-shadow(0 4px 12px rgba(254, 16, 99, 0.35))"
        >
          <img src="/isologo.svg" alt="TM Code" style={{ width: '100%', height: '100%' }} />
        </Box>

        {/* Expand */}
        <Box
          as="button"
          aria-label={t('welcome.expandSidebar')}
          title={t('welcome.expandSidebar')}
          mb={4}
          {...railBtnProps}
          onClick={() => setCollapsed(false)}
        >
          <Icon as={VscLayoutSidebarLeft} fontSize="16px" />
        </Box>

        {/* Primary actions */}
        <VStack gap="2px" mb={3} flexShrink={0}>
          {primaryActions.map(action => (
            <Box
              key={action.label}
              as="button"
              title={action.label}
              aria-label={action.label}
              {...railBtnProps}
              onClick={action.onClick}
            >
              <Icon as={action.icon} fontSize="16px" />
            </Box>
          ))}
        </VStack>

        <Box w="20px" h="1px" bg="rgba(255,255,255,0.08)" mb={3} flexShrink={0} />

        {/* Workspace projects — monogram only */}
        <VStack
          gap="2px"
          flex={1}
          minH={0}
          overflowY="auto"
          overflowX="hidden"
          w="100%"
          align="center"
          css={{
            '&::-webkit-scrollbar': { width: '0', display: 'none' },
            scrollbarWidth: 'none',
          }}
        >
          {recentProjects.map((project, index) => {
            const monogram = (project.name || '?').trim().slice(0, 1).toUpperCase()
            const isActive = activeProjectPath === project.path
            const status = agentStatuses[project.path]
            return (
              <Box
                key={project.id || `rail-${index}`}
                as="button"
                title={project.name + (project.path ? `\n${project.path}` : '')}
                aria-label={project.name}
                position="relative"
                {...railBtnProps}
                bg={isActive ? 'rgba(254, 16, 99, 0.14)' : undefined}
                color={isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary}
                borderLeft={isActive ? '2px solid' : '2px solid transparent'}
                borderColor={isActive ? tokens.colors.accent.primary : 'transparent'}
                borderRadius="0 8px 8px 0"
                onClick={() => project.path && onOpenProject(project.path)}
                onContextMenu={(e: React.MouseEvent) => handleProjectContextMenu(e, project)}
              >
                <Text fontSize="12px" fontWeight="700" lineHeight="1" userSelect="none">
                  {monogram}
                </Text>
                {status?.state === 'running' && (
                  <Box
                    position="absolute"
                    top="6px"
                    right="6px"
                    w="5px"
                    h="5px"
                    borderRadius="full"
                    bg={tokens.colors.accent.primary}
                    boxShadow="0 0 0 1px rgba(15,15,15,0.9)"
                  />
                )}
              </Box>
            )
          })}
        </VStack>

        <TeamSection compact />
        <UserFooter appVersion={appVersion} compact />
      </Box>
    )
  }

  // ── Expanded sidebar ──────────────────────────────────────────────────
  return (
    <Box
      width={SIDEBAR_EXPANDED_W}
      minWidth={SIDEBAR_EXPANDED_W}
      maxWidth="300px"
      h="100%"
      minH={0}
      bg="rgba(15, 15, 15, 0.95)"
      backdropFilter="blur(24px)"
      borderRight="1px solid"
      borderColor="rgba(255, 255, 255, 0.05)"
      display="flex"
      flexDirection="column"
      py={{ base: 4, md: 6 }}
      px={{ base: 3, md: 4 }}
      pt={{ base: 6, md: 8 }}
      data-no-drag
      data-sidebar-collapsed="false"
      position="relative"
      overflow="hidden"
      css={{
        '@media (max-width: 520px)': {
          '& [data-sidebar-logo]': { marginBottom: '14px' },
          '& [data-sidebar-logo-mark]': { width: '26px', height: '26px', marginRight: '8px' },
          '& [data-sidebar-logo-title]': { fontSize: '15px' },
          '& [data-sidebar-actions]': { marginBottom: '18px' },
          '& [data-sidebar-clear-label], & [data-sidebar-task-time], & [data-sidebar-footer-version]': {
            display: 'none',
          },
          '& [data-sidebar-section-label]': { fontSize: '10px', letterSpacing: '0.08em' },
        },
      }}
    >
      {/* Logo + collapse control */}
      <Flex data-sidebar-logo alignItems="center" mb={5} position="relative">
        <Box
          data-sidebar-logo-mark
          width="30px"
          height="30px"
          mr={2.5}
          flexShrink={0}
          filter="drop-shadow(0 4px 12px rgba(254, 16, 99, 0.35))"
        >
          <img src="/isologo.svg" alt="TM Code" style={{ width: '100%', height: '100%' }} />
        </Box>
        <Heading
          data-sidebar-logo-title
          fontSize="16px"
          fontWeight="800"
          color="white"
          letterSpacing="-0.3px"
          flex={1}
          minW={0}
          lineClamp={1}
        >
          TM Code
        </Heading>
        <Box
          as="button"
          aria-label={t('welcome.collapseSidebar')}
          title={t('welcome.collapseSidebar')}
          display="flex"
          alignItems="center"
          justifyContent="center"
          width="28px"
          height="28px"
          borderRadius="8px"
          flexShrink={0}
          ml={1}
          color={tokens.colors.text.muted}
          cursor="pointer"
          transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}`}
          _hover={{ bg: 'rgba(255, 255, 255, 0.08)', color: tokens.colors.text.primary }}
          _focusVisible={{ outline: '2px solid rgba(254, 16, 99, 0.45)', outlineOffset: '1px' }}
          onClick={() => setCollapsed(true)}
        >
          <Icon as={VscLayoutSidebarLeftOff} fontSize="15px" />
        </Box>
      </Flex>

      {/* Primary actions */}
      <VStack data-sidebar-actions align="stretch" gap="2px" mb={6} position="relative">
        {primaryActions.map(action => (
          <Flex
            key={action.label}
            as="button"
            alignItems="center"
            gap={2.5}
            w="100%"
            px={2}
            py="7px"
            borderRadius="8px"
            color={tokens.colors.text.secondary}
            cursor="pointer"
            transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}`}
            textAlign="left"
            _hover={{ bg: 'rgba(255, 255, 255, 0.05)', color: tokens.colors.text.primary }}
            onClick={action.onClick}
          >
            <Icon as={action.icon} fontSize="15px" flexShrink={0} />
            <Text fontSize="13px" fontWeight="500" flex={1} lineClamp={1}>
              {action.label}
            </Text>
          </Flex>
        ))}
      </VStack>

      {/* Workspace projects — stable list, not recents-by-last-opened */}
      <VStack align="stretch" flex={1} overflow="hidden" minH={0}>
        <HStack data-sidebar-section-row px={2} mb={2} justify="space-between">
          <HStack gap={2}>
            <Icon color={tokens.colors.text.muted} fontSize="12px">
              <LuFolderOpen />
            </Icon>
            <Text
              data-sidebar-section-label
              fontSize="11px"
              fontWeight="700"
              textTransform="uppercase"
              color={tokens.colors.text.muted}
              letterSpacing="1px"
            >
              {t('welcome.projects')}
            </Text>
          </HStack>

          {onClearRecent && recentProjects.length > 0 && (
            <Flex
              as="button"
              alignItems="center"
              justifyContent="center"
              gap={1}
              px={2}
              h="22px"
              borderRadius="6px"
              bg="transparent"
              border="1px solid transparent"
              cursor="pointer"
              transition="all 0.15s ease"
              _hover={{
                bg: 'rgba(254, 16, 99, 0.08)',
                borderColor: 'rgba(254, 16, 99, 0.25)',
              }}
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClearRecent() }}
              title={t('welcome.clearProjectsTitle')}
              aria-label={t('welcome.clearProjectsTitle')}
            >
              <Icon color={tokens.colors.text.muted} fontSize="11px">
                <LuEraser />
              </Icon>
              <Text
                data-sidebar-clear-label
                fontSize="9px"
                fontWeight="700"
                textTransform="uppercase"
                letterSpacing="0.08em"
                color={tokens.colors.text.muted}
              >
                {t('welcome.clearProjects')}
              </Text>
            </Flex>
          )}
        </HStack>

        <VStack
          align="stretch"
          gap="2px"
          flex={1}
          overflowY="auto"
          minH={0}
          css={{
            '&::-webkit-scrollbar': { width: '4px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              background: 'rgba(255,255,255,0.1)',
              borderRadius: '4px',
            },
          }}
        >
          {recentProjects.length === 0 && (
            <Text fontSize="12px" color={tokens.colors.text.muted} px={3} py={4} textAlign="center">
              {t('welcome.noProjects')}
            </Text>
          )}

          {recentProjects.map((project, index) => (
            <ProjectGroup
              key={project.id || `project-${index}`}
              project={project}
              isActive={activeProjectPath === project.path}
              agentStatus={agentStatuses[project.path] ?? null}
              ambiguous={duplicateNames.has(project.name)}
              onOpen={() => project.path && onOpenProject(project.path)}
              onContextMenu={(e) => handleProjectContextMenu(e, project)}
            />
          ))}
        </VStack>
      </VStack>

      <TeamSection />
      <UserFooter appVersion={appVersion} />
    </Box>
  )
}

/** Team indicator + Team Chat entry point on the Welcome screen. Self-contained:
 *  reads the team-plan gate + collab presence directly. Hidden unless the team
 *  plan is active (membership AND non-expired term). The chat button opens the
 *  TeamChatPanel, which WelcomeScreen mounts while no project is open. */
function TeamSection({ compact = false }: { compact?: boolean }) {
  const teamActive = useBillingStore(isTeamCollabActive)
  const connected = useCollabStore(s => s.connected)
  const peers = useCollabStore(s => s.peers)
  const chatUnread = useCollabStore(s => s.chatUnread)
  const setChatOpen = useCollabStore(s => s.setChatOpen)

  if (!teamActive) return null

  if (compact) {
    return (
      <Box
        as="button"
        {...railBtnProps}
        title={connected
          ? `${t('team.chatTitle')} · ${t('team.peersOnline').replace('{count}', String(peers.length))}`
          : t('team.chatTitle')}
        aria-label={t('team.chatTitle')}
        position="relative"
        mt={2}
        mb={1}
        onClick={() => setChatOpen(true)}
      >
        <LuMessagesSquare size={16} />
        <Box
          position="absolute"
          top="7px"
          left="7px"
          w="6px"
          h="6px"
          borderRadius="full"
          bg={connected ? tokens.colors.accent.greenBright : tokens.colors.text.muted}
          boxShadow="0 0 0 1px rgba(15,15,15,0.95)"
        />
        {chatUnread > 0 && (
          <Box
            position="absolute"
            top="4px"
            right="4px"
            minW="12px"
            h="12px"
            px="2px"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            color={tokens.colors.badge.notificationText}
            fontSize="8px"
            fontWeight="700"
            lineHeight="12px"
            textAlign="center"
          >
            {chatUnread > 9 ? '9+' : chatUnread}
          </Box>
        )}
      </Box>
    )
  }

  return (
    <VStack align="stretch" gap="2px" mt={3} pt={3} borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
      <Flex align="center" gap={2} px={1} mb={1}>
        <Box
          w="6px"
          h="6px"
          borderRadius="full"
          bg={connected ? tokens.colors.accent.greenBright : tokens.colors.text.muted}
          flexShrink={0}
        />
        <Text fontSize="10px" fontWeight="700" letterSpacing="0.06em" textTransform="uppercase" color={tokens.colors.text.muted}>
          {t('settings.teamTitle')}
        </Text>
        {connected && (
          <Text fontSize="10px" color={tokens.colors.text.disabled}>
            {t('team.peersOnline').replace('{count}', String(peers.length))}
          </Text>
        )}
      </Flex>
      <Flex
        as="button"
        align="center"
        gap={2}
        px={2}
        py={1.5}
        borderRadius="6px"
        transition={`all ${tokens.transition.fast}`}
        _hover={{ bg: 'rgba(255,255,255,0.05)' }}
        onClick={() => setChatOpen(true)}
      >
        <LuMessagesSquare size={14} color={tokens.colors.text.secondary} />
        <Text fontSize="12px" color={tokens.colors.text.secondary}>{t('team.chatTitle')}</Text>
        {chatUnread > 0 && (
          <Box
            ml="auto"
            px={1.5}
            minW="16px"
            textAlign="center"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            color={tokens.colors.badge.notificationText}
            fontSize="9px"
            fontWeight="700"
          >
            {chatUnread}
          </Box>
        )}
      </Flex>
    </VStack>
  )
}

// ─── Project group (folder + nested parallel work) ──────────────────────

interface ProjectGroupProps {
  project: RecentProject
  isActive: boolean
  agentStatus: ProjectAgentStatus | null
  /** True when another recent shares this project's name → show a parent hint. */
  ambiguous: boolean
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

/** How long we keep the "Stopping…" chip for a cross-window request before
 *  offering a re-click. Matches the owner heartbeat ceiling (~30s) + slack. */
const REMOTE_STOP_FEEDBACK_MS = 40_000

type StopUiPhase = 'idle' | 'local' | 'remote' | 'timeout'

function ProjectGroup({
  project,
  isActive,
  agentStatus,
  ambiguous,
  onOpen,
  onContextMenu,
}: ProjectGroupProps) {
  // Disambiguate same-named projects (see duplicateNames) with the parent dir.
  const parentDir = ambiguous && project.path
    ? project.path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').slice(-2, -1)[0] ?? null
    : null

  // Stop button feedback: local abort is instant; remote only writes a disk
  // flag the owning window consumes on heartbeat/turn (≤30s). Keep the chip
  // visible (not hover-only) while waiting so the click does not feel dead.
  const [stopPhase, setStopPhase] = useState<StopUiPhase>('idle')

  useEffect(() => {
    if (agentStatus?.state !== 'running' && stopPhase !== 'idle') {
      setStopPhase('idle')
    }
  }, [agentStatus?.state, stopPhase])

  useEffect(() => {
    if (stopPhase !== 'remote') return
    const timer = window.setTimeout(() => {
      setStopPhase((p) => (p === 'remote' ? 'timeout' : p))
    }, REMOTE_STOP_FEEDBACK_MS)
    return () => window.clearTimeout(timer)
  }, [stopPhase])

  const handleStopClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!project.path) return
    if (stopPhase === 'local' || stopPhase === 'remote') return
    const local = stopProjectAgent(project.path)
    setStopPhase(local ? 'local' : 'remote')
  }, [project.path, stopPhase])

  const openInNewWindow = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!project.path) return
    void invoke('open_new_instance', { projectPath: project.path }).catch(() => {})
  }, [project.path])

  const stopBusy = stopPhase === 'local' || stopPhase === 'remote'
  const stopTitle =
    stopPhase === 'local'
      ? t('parallel.stoppingLocalHint')
      : stopPhase === 'remote'
        ? t('parallel.stoppingRemoteHint')
        : stopPhase === 'timeout'
          ? t('parallel.stopTimeoutHint')
          : t('parallel.stopTask')

  return (
    <Box
      role="group"
      css={{
        // Hover actions on the folder row stay invisible until the group is
        // hovered — keeps the tree calm at rest (reference rhythm).
        // Exception: stop-in-progress chip stays visible (data-sidebar-stop-busy).
        '& [data-sidebar-hover-action]': { opacity: 0 },
        '&:hover [data-sidebar-hover-action]': { opacity: 1 },
        '& [data-sidebar-hover-action]:focus-visible': { opacity: 1 },
        '& [data-sidebar-stop-busy]': { opacity: '1 !important' },
      }}
    >
      {/* Folder row */}
      <Flex
        alignItems="center"
        gap={2}
        px={2}
        py="6px"
        borderRadius="8px"
        cursor="pointer"
        transition={`background ${tokens.transition.fast}`}
        _hover={{ bg: 'rgba(255, 255, 255, 0.05)' }}
        onClick={() => { onOpen(); if (isActive) openMainSessionChat(project.path) }}
        onContextMenu={onContextMenu}
        title={project.path}
      >
        <Icon
          as={LuFolderOpen}
          fontSize="15px"
          flexShrink={0}
          color={isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary}
        />
        <Flex flex={1} minW={0} alignItems="baseline" gap={1.5} overflow="hidden">
          <Text
            fontSize="13px"
            fontWeight={isActive ? '650' : '500'}
            color={isActive ? tokens.colors.text.primary : tokens.colors.text.secondary}
            lineClamp={1}
            minW={0}
          >
            {project.name}
          </Text>
          {parentDir && (
            <Text
              fontSize="10px"
              color={tokens.colors.text.muted}
              opacity={0.55}
              flexShrink={0}
              lineClamp={1}
              title={project.path}
            >
              {parentDir}
            </Text>
          )}
        </Flex>
        {/* Open in another window — hidden for the project THIS window owns
            (same project in two windows collides on the shared state dir). */}
        {!isActive && project.path && (
          <Flex
            as="button"
            data-sidebar-hover-action
            alignItems="center"
            justifyContent="center"
            w="22px"
            h="22px"
            borderRadius="6px"
            flexShrink={0}
            color={tokens.colors.text.muted}
            cursor="pointer"
            transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}, opacity ${tokens.transition.fast}`}
            _hover={{ bg: 'rgba(255, 255, 255, 0.08)', color: tokens.colors.text.primary }}
            onClick={openInNewWindow}
            title={t('welcome.openInNewWindowTitle')}
            aria-label={t('welcome.openInNewWindowTitle')}
          >
            <LuExternalLink size={12} />
          </Flex>
        )}
        {/* Inline agent status — ONE per project (running pulse / done / error),
            else the relative-opened time. F3/MDI: one agent per project. */}
        {agentStatus?.state === 'running' ? (
          <Flex
            alignItems="center"
            gap={1.5}
            flexShrink={0}
            title={[
              agentStatus.label || t('welcome.agentWorking'),
              agentStatus.pid ? `pid ${agentStatus.pid}` : null,
              agentStatus.startedAt ? shortAgo(agentStatus.startedAt) : null,
              t('welcome.agentOwnerHint'),
            ].filter(Boolean).join(' · ')}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <Box
              w="7px"
              h="7px"
              borderRadius="full"
              bg={tokens.colors.accent.primary}
              flexShrink={0}
              css={{
                '@keyframes tmSidebarProjPulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
                animation: 'tmSidebarProjPulse 1.2s ease-in-out infinite',
              }}
            />
            {agentStatus.startedAt && (
              <Text data-sidebar-task-time fontSize="10px" color={tokens.colors.text.disabled} flexShrink={0}>
                {shortAgo(agentStatus.startedAt)}
              </Text>
            )}
            {project.path && (
              <Flex
                as="button"
                data-sidebar-hover-action=""
                {...(stopBusy || stopPhase === 'timeout'
                  ? ({ 'data-sidebar-stop-busy': '' } as const)
                  : {})}
                alignItems="center"
                justifyContent="center"
                gap="3px"
                h="20px"
                px="6px"
                borderRadius="5px"
                flexShrink={0}
                bg={stopBusy ? 'rgba(248, 81, 73, 0.2)' : 'rgba(248, 81, 73, 0.12)'}
                border="1px solid rgba(248, 81, 73, 0.3)"
                color={tokens.colors.accent.red}
                fontSize="9px"
                fontWeight="700"
                cursor={stopBusy ? 'wait' : 'pointer'}
                pointerEvents={stopBusy ? 'none' : undefined}
                title={stopTitle}
                aria-label={stopTitle}
                aria-busy={stopBusy}
                aria-disabled={stopBusy}
                _hover={stopBusy ? undefined : { bg: 'rgba(248, 81, 73, 0.22)' }}
                onClick={handleStopClick}
              >
                {stopBusy ? (
                  <Box
                    as="span"
                    display="inline-flex"
                    css={{
                      animation: 'tmSidebarStopSpin 0.7s linear infinite',
                      '@keyframes tmSidebarStopSpin': { to: { transform: 'rotate(360deg)' } },
                    }}
                  >
                    <LuLoader size={10} />
                  </Box>
                ) : (
                  <LuSquare size={8} fill="currentColor" />
                )}
                {stopBusy ? t('parallel.stoppingShort') : t('parallel.stopShort')}
              </Flex>
            )}
          </Flex>
        ) : agentStatus?.state === 'done' ? (
          <Flex alignItems="center" gap={1.5} flexShrink={0} title={agentStatus.label || t('welcome.agentDone')}>
            <Icon as={LuCheck} fontSize="12px" color={tokens.colors.status.running} />
            <Text data-sidebar-task-time fontSize="10px" color={tokens.colors.text.disabled} flexShrink={0}>
              {shortAgo(agentStatus.updatedAt)}
            </Text>
          </Flex>
        ) : agentStatus?.state === 'error' ? (
          <Flex alignItems="center" gap={1.5} flexShrink={0} title={agentStatus.label || t('welcome.agentError')}>
            <Box w="7px" h="7px" borderRadius="full" bg={tokens.colors.status.error} flexShrink={0} />
            <Text data-sidebar-task-time fontSize="10px" color={tokens.colors.text.disabled} flexShrink={0}>
              {shortAgo(agentStatus.updatedAt)}
            </Text>
          </Flex>
        ) : null}
      </Flex>

      {/* Running agent: show a clean one-line task title under the folder row
          (not the raw multi-line prompt dump). */}
      {agentStatus?.state === 'running' && agentStatus.label && (
        <Flex
          align="center"
          gap={2}
          pl="34px"
          pr={2}
          pb="6px"
          mt="-2px"
          minW={0}
          title={agentStatus.description || agentStatus.label}
        >
          <Text
            fontSize="11px"
            color={tokens.colors.text.muted}
            lineClamp={1}
            minW={0}
            flex={1}
          >
            {agentStatus.label}
          </Text>
        </Flex>
      )}
    </Box>
  )
}


// ─── User footer (avatar + menu, reference layout) ──────────────────────

function UserFooter({ appVersion, compact = false }: { appVersion: string; compact?: boolean }) {
  const user = useAuthStore(s => s.user)
  const [menuOpen, setMenuOpen] = useState(false)

  const initials = user ? getInitials(user.email, user.displayName) : '?'
  // Fallback to the email's local part, capitalized (e.g. "kwanzaonline" →
  // "Kwanzaonline"), matching the Settings profile so both surfaces agree.
  const emailName = user?.email?.split('@')[0] ?? ''
  const displayName = user?.displayName?.trim()
    || (emailName ? emailName.charAt(0).toUpperCase() + emailName.slice(1) : '')

  // Mesma lógica dual do antigo menu do titlebar: sem projecto → ecrã de
  // settings do Welcome; com projecto → viewMode settings do workspace.
  const openSettings = useCallback(() => {
    setMenuOpen(false)
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
  }, [])

  const menuItems = [
    {
      icon: <LuSettings size={13} />,
      label: t('menu.settings'),
      onClick: openSettings,
    },
    {
      icon: <FiAlertCircle size={13} />,
      label: t('issueReporter.menuItem'),
      onClick: () => {
        setMenuOpen(false)
        window.dispatchEvent(new CustomEvent('app:report-issue'))
      },
    },
    {
      icon: <FiLogOut size={13} />,
      label: t('common.signOut'),
      onClick: () => {
        setMenuOpen(false)
        void signOutWithGuard()
      },
    },
  ]

  const menuPanel = menuOpen ? (
    <>
      <Box position="fixed" inset={0} zIndex={999} onClick={() => setMenuOpen(false)} />
      <Box
        position="absolute"
        bottom="calc(100% + 6px)"
        left={compact ? '4px' : 0}
        right={compact ? 'auto' : 0}
        minW={compact ? '180px' : undefined}
        zIndex={1000}
        bg={tokens.colors.dialog.bg}
        border={`1px solid ${tokens.colors.border.panel}`}
        borderRadius="10px"
        boxShadow="0 -8px 28px rgba(0,0,0,0.4)"
        py={1}
      >
        {menuItems.map(item => (
          <Flex
            key={item.label}
            align="center"
            gap={2}
            px={3}
            py="7px"
            cursor="pointer"
            role="button"
            color={tokens.colors.text.secondary}
            transition={`background ${tokens.transition.fast}`}
            _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
            css={{ '& *': { pointerEvents: 'none' } }}
            onClick={item.onClick}
          >
            {item.icon}
            <Text fontSize="12px">{item.label}</Text>
          </Flex>
        ))}
      </Box>
    </>
  ) : null

  if (compact) {
    return (
      <Box
        pt={2}
        mt={1}
        borderTop="1px solid rgba(255,255,255,0.05)"
        flexShrink={0}
        position="relative"
        display="flex"
        justifyContent="center"
        w="100%"
      >
        {menuPanel}
        <Box
          as="button"
          title={displayName || t('menu.settings')}
          aria-label={displayName || t('menu.settings')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="36px"
          h="36px"
          borderRadius="full"
          overflow="hidden"
          bg={tokens.colors.accent.primary}
          cursor="pointer"
          flexShrink={0}
          onClick={() => setMenuOpen(open => !open)}
        >
          {user?.photoURL ? (
            <img src={user.photoURL} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Text fontSize="10px" fontWeight="700" color="#fff" lineHeight="1">
              {initials}
            </Text>
          )}
        </Box>
      </Box>
    )
  }

  return (
    <Box
      pt={3}
      mt={3}
      borderTop="1px solid rgba(255,255,255,0.05)"
      flexShrink={0}
      position="relative"
    >
      {menuPanel}

      <Flex alignItems="center" gap={2.5} px={1}>
        <Flex
          as="button"
          alignItems="center"
          gap={2.5}
          flex={1}
          minW={0}
          cursor="pointer"
          borderRadius="8px"
          px={1}
          py="4px"
          transition={`background ${tokens.transition.fast}`}
          _hover={{ bg: 'rgba(255, 255, 255, 0.05)' }}
          onClick={() => setMenuOpen(open => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <Flex
            w="26px"
            h="26px"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            align="center"
            justify="center"
            flexShrink={0}
            overflow="hidden"
          >
            {user?.photoURL ? (
              <img src={user.photoURL} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <Text fontSize="10px" fontWeight="700" color="#fff" lineHeight="1">
                {initials}
              </Text>
            )}
          </Flex>
          <Text
            fontSize="12.5px"
            fontWeight="600"
            color={tokens.colors.text.primary}
            lineClamp={1}
            flex={1}
            minW={0}
            textAlign="left"
          >
            {displayName}
          </Text>
        </Flex>

        <Text data-sidebar-footer-version fontSize="10px" color={tokens.colors.text.disabled} opacity={0.6} flexShrink={0}>
          {appVersion}
        </Text>

        <Flex
          as="button"
          width="26px"
          height="26px"
          alignItems="center"
          justifyContent="center"
          borderRadius="6px"
          cursor="pointer"
          flexShrink={0}
          color={tokens.colors.text.muted}
          transition={`all ${tokens.transition.fast}`}
          _hover={{ bg: 'rgba(255, 255, 255, 0.06)', color: tokens.colors.text.primary }}
          onClick={openSettings}
          title={t('menu.settings')}
          aria-label={t('menu.settings')}
        >
          <LuSettings size={14} />
        </Flex>
      </Flex>
    </Box>
  )
}

export default WelcomeSidebar
