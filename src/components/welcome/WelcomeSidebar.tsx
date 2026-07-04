import React, { useCallback, useEffect, useState } from 'react'
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
  LuFolder,
  LuFolderOpen,
  LuGitBranch,
  LuClock,
  LuChevronRight,
  LuSettings,
  LuEraser,
  LuPlus,
} from 'react-icons/lu'
import { getVersion } from '@tauri-apps/api/app'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { showProjectContextMenu } from '@/components/projectContextMenu'
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

// ─── Relative time helper ──────────────────────────────────────────────
function relativeTime(dateStr?: string): string | null {
  if (!dateStr) return null
  const now = new Date()
  // Rust stores last_opened as unix seconds (e.g. "1748112000")
  const then = /^\d+$/.test(dateStr)
    ? new Date(Number(dateStr) * 1000)
    : new Date(dateStr)
  const diffMs = now.getTime() - then.getTime()
  if (diffMs < 0) return null

  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return t('welcome.today')
  if (diffMin < 60) return null // don't show minutes

  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return t('welcome.today')

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return t('welcome.yesterday')
  if (diffDays <= 30) return t('welcome.daysAgo').replace('{n}', String(diffDays))

  // Older than 30 days: show short date
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface WelcomeSidebarProps {
  recentProjects: RecentProject[]
  onNewProject: () => void
  onOpenFolder: () => void
  onCloneRepository: () => void
  onOpenProject: (path?: string) => void
  onSettings?: () => void
  activeProjectPath?: string | null
  /** Clear the recent projects list. The caller handles the confirmation
   *  dialog; this component just surfaces the button. */
  onClearRecent?: () => void
}

const WelcomeSidebar: React.FC<WelcomeSidebarProps> = ({
  recentProjects,
  onNewProject,
  onOpenFolder,
  onCloneRepository,
  onOpenProject,
  onSettings,
  activeProjectPath,
  onClearRecent,
}) => {
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    getAppVersion().then(setAppVersion)
  }, [])

  const handleProjectContextMenu = useCallback((e: React.MouseEvent, project: RecentProject) => {
    e.preventDefault()
    e.stopPropagation()
    showProjectContextMenu(project).catch(() => {})
  }, [])

  const truncatePath = (path: string, maxLen = 38) => {
    if (path.length <= maxLen) return path
    const parts = path.split(/[/\\]/)
    if (parts.length <= 3) return '...' + path.slice(-maxLen)
    const sep = path.includes('\\') ? '\\' : '/'
    return parts[0] + sep + '...' + sep + parts.slice(-2).join(sep)
  }

  return (
    <Box
      width="clamp(200px, 30vw, 300px)"
      minWidth="clamp(200px, 30vw, 300px)"
      maxWidth="300px"
      h="100%"
      minH={0}
      bg="rgba(15, 15, 15, 0.95)"
      backdropFilter="blur(24px)"
      borderRight="1px solid"
      borderColor="rgba(254, 16, 99, 0.15)"
      display="flex"
      flexDirection="column"
      py={{ base: 4, md: 8 }}
      px={{ base: 3, md: 5 }}
      pt={{ base: 8, md: 12 }}
      data-no-drag
      position="relative"
      overflow="hidden"
      css={{
        '@media (max-width: 520px)': {
          '& [data-sidebar-logo]': {
            marginBottom: '18px',
          },
          '& [data-sidebar-logo-mark]': {
            width: '30px',
            height: '30px',
            marginRight: '10px',
          },
          '& [data-sidebar-logo-title]': {
            fontSize: '16px',
          },
          '& [data-sidebar-actions]': {
            marginBottom: '22px',
          },
          '& [data-sidebar-action]': {
            gap: '9px',
            paddingLeft: '9px',
            paddingRight: '9px',
            paddingTop: '8px',
            paddingBottom: '8px',
          },
          '& [data-sidebar-action-icon]': {
            width: '25px',
            height: '25px',
          },
          '& [data-sidebar-action-label]': {
            fontSize: '12px',
          },
          '& [data-sidebar-action-chevron]': {
            display: 'none',
          },
          '& [data-sidebar-clear-label], & [data-sidebar-project-time], & [data-sidebar-project-arrow], & [data-sidebar-footer-powered]': {
            display: 'none',
          },
          '& [data-sidebar-section-row]': {
            paddingLeft: '4px',
            paddingRight: '4px',
          },
          '& [data-sidebar-section-label]': {
            fontSize: '10px',
            letterSpacing: '0.08em',
          },
          '& [data-sidebar-project-row]': {
            gap: '9px',
            paddingLeft: '8px',
            paddingRight: '8px',
          },
          '& [data-sidebar-project-icon]': {
            width: '25px',
            height: '25px',
          },
        },
      }}
    >
      {/* Subtle glow at top */}
      <Box
        position="absolute"
        top="-60px"
        left="50%"
        transform="translateX(-50%)"
        width="200px"
        height="120px"
        bg="radial-gradient(ellipse, rgba(254, 16, 99, 0.12) 0%, transparent 70%)"
        pointerEvents="none"
      />

      {/* Logo */}
      <Flex data-sidebar-logo alignItems="center" mb={6} position="relative">
        <Box
          data-sidebar-logo-mark
          width="36px"
          height="36px"
          mr={3}
          flexShrink={0}
          filter="drop-shadow(0 4px 12px rgba(254, 16, 99, 0.4))"
        >
          <img
            src="/isologo.svg"
            alt="TM Code"
            style={{ width: '100%', height: '100%' }}
          />
        </Box>
        <Heading
          data-sidebar-logo-title
          fontSize="18px"
          fontWeight="800"
          color="white"
          letterSpacing="-0.3px"
        >
          TM Code
        </Heading>
      </Flex>

      {/* Primary project actions */}
      <VStack data-sidebar-actions align="stretch" gap={2} mb={8} position="relative">
        {[
          { icon: LuPlus, label: t('welcome.newProject'), onClick: onNewProject, color: tokens.colors.accent.primary },
          { icon: LuFolderOpen, label: t('welcome.openProject'), onClick: onOpenFolder, color: tokens.colors.accent.greenBright },
          { icon: LuGitBranch, label: t('welcome.cloneRepo'), onClick: onCloneRepository, color: tokens.colors.accent.purple },
        ].map((action) => (
          <Flex
            data-sidebar-action
            key={action.label}
            as="button"
            alignItems="center"
            gap={3}
            w="100%"
            px={3}
            py={2.5}
            borderRadius="8px"
            bg="rgba(255, 255, 255, 0.04)"
            border="1px solid"
            borderColor="rgba(255, 255, 255, 0.07)"
            color={tokens.colors.text.primary}
            cursor="pointer"
            transition="all 0.18s ease"
            textAlign="left"
            _hover={{
              bg: 'rgba(255, 255, 255, 0.07)',
              borderColor: `${action.color}55`,
              transform: 'translateY(-1px)',
            }}
            onClick={action.onClick}
          >
            <Flex
              data-sidebar-action-icon
              width="28px"
              height="28px"
              borderRadius="7px"
              alignItems="center"
              justifyContent="center"
              bg={`${action.color}15`}
              flexShrink={0}
            >
              <Icon as={action.icon} fontSize="14px" color={action.color} />
            </Flex>
            <Text data-sidebar-action-label fontSize="13px" fontWeight="600" flex={1} lineClamp={1}>
              {action.label}
            </Text>
            <Icon data-sidebar-action-chevron as={LuChevronRight} fontSize="12px" color={tokens.colors.text.disabled} />
          </Flex>
        ))}
      </VStack>

      {/* Recent projects */}
      <VStack align="stretch" flex={1} overflow="hidden" minH={0}>
        <HStack data-sidebar-section-row px={2} mb={3} justify="space-between">
          <HStack gap={2}>
            <Icon color={tokens.colors.text.muted} fontSize="12px">
              <LuClock />
            </Icon>
            <Text
              data-sidebar-section-label
              fontSize="11px"
              fontWeight="700"
              textTransform="uppercase"
              color={tokens.colors.text.muted}
              letterSpacing="1px"
            >
              {t('welcome.recent')}
            </Text>
          </HStack>

          {/* Clear-all button */}
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
              title={t('welcome.clearRecentTitle')}
              aria-label={t('welcome.clearRecentTitle')}
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
                {t('welcome.clearRecent')}
              </Text>
            </Flex>
          )}
        </HStack>

        <VStack
          align="stretch"
          gap={0}
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
              {t('welcome.noRecent')}
            </Text>
          )}

          {recentProjects.length > 0 && (
            recentProjects.map((project, index) => (
              <ProjectRow
                key={project.id || `project-${index}`}
                project={project}
                truncatePath={truncatePath}
                isActive={activeProjectPath === project.path}
                onClick={() => project.path && onOpenProject(project.path)}
                onContextMenu={(e) => handleProjectContextMenu(e, project)}
              />
            ))
          )}
        </VStack>
      </VStack>

      {/* Footer — powered by + settings + version */}
      <Flex
        direction="column"
        pt={{ base: 3, md: 4 }}
        mt={{ base: 3, md: 4 }}
        borderTop="1px solid rgba(255,255,255,0.05)"
        gap={{ base: 2, md: 3 }}
        flexShrink={0}
      >
        <Flex alignItems="center" justifyContent="space-between" px={2}>
          <Flex
            width="28px"
            height="28px"
            alignItems="center"
            justifyContent="center"
            borderRadius="6px"
            cursor="pointer"
            transition="all 0.2s ease"
            _hover={{ bg: 'rgba(255, 255, 255, 0.06)' }}
            onClick={onSettings}
          >
            <Icon color={tokens.colors.text.muted} fontSize="15px">
              <LuSettings />
            </Icon>
          </Flex>
          <Text fontSize="10px" color={tokens.colors.text.disabled} opacity={0.6}>
            {appVersion}
          </Text>
        </Flex>
        <Text
          data-sidebar-footer-powered
          fontSize="9px"
          color={tokens.colors.text.disabled}
          opacity={0.4}
          textAlign="center"
          letterSpacing="0.3px"
        >
          Powered by Toque Media, Lda
        </Text>
      </Flex>
    </Box>
  )
}

// ─── Project row ────────────────────────────────────────────────────────

interface ProjectRowProps {
  project: RecentProject
  truncatePath: (path: string, maxLen?: number) => string
  isActive?: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

const ProjectRow: React.FC<ProjectRowProps> = ({
  project,
  truncatePath,
  isActive = false,
  onClick,
  onContextMenu,
}) => {
  const timeLabel = relativeTime(project.lastOpened)

  return (
    <Flex
      data-sidebar-project-row
      alignItems="center"
      gap={3}
      px={3}
      py={2}
      borderRadius="8px"
      cursor="pointer"
      transition="all 0.2s ease"
      bg={isActive ? 'rgba(254, 16, 99, 0.12)' : 'transparent'}
      border="1px solid"
      borderColor={isActive ? 'rgba(254, 16, 99, 0.35)' : 'transparent'}
      _hover={{
        bg: isActive ? 'rgba(254, 16, 99, 0.16)' : 'rgba(255, 255, 255, 0.05)',
        transform: 'translateX(2px)',
      }}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {/* Icon */}
      <Flex
        data-sidebar-project-icon
        width="28px"
        height="28px"
        borderRadius="6px"
        alignItems="center"
        justifyContent="center"
        bg={isActive ? 'rgba(254, 16, 99, 0.16)' : 'rgba(255, 255, 255, 0.05)'}
        flexShrink={0}
      >
        <Icon
          as={LuFolder}
          fontSize="14px"
          color={isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary}
        />
      </Flex>

      {/* Name + path */}
      <Box flex="1" minW={0}>
        <Text
          fontSize="13px"
          fontWeight={isActive ? '650' : '500'}
          color={isActive ? tokens.colors.accent.primary : tokens.colors.text.primary}
          lineClamp={1}
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {project.name}
        </Text>
        <Flex align="center" gap={2}>
          <Text
            fontSize="10px"
            color={tokens.colors.text.muted}
            lineClamp={1}
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            flex="1"
            minW={0}
          >
            {truncatePath(project.path)}
          </Text>
          {timeLabel && (
            <Text
              data-sidebar-project-time
              fontSize="9px"
              color={tokens.colors.text.disabled}
              flexShrink={0}
              opacity={0.6}
            >
              {timeLabel}
            </Text>
          )}
        </Flex>
      </Box>

      {/* Hover arrow */}
      <Flex data-sidebar-project-arrow gap={1} alignItems="center" opacity={0.5} flexShrink={0}>
        <Icon as={LuChevronRight} fontSize="12px" color={tokens.colors.text.disabled} />
      </Flex>
    </Flex>
  )
}

export default WelcomeSidebar
