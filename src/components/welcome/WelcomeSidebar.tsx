import React, { useEffect, useState } from 'react'
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
  LuClock,
  LuChevronRight,
  LuSettings,
  LuEraser,
} from 'react-icons/lu'
import { getVersion } from '@tauri-apps/api/app'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

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

interface RecentProject {
  id?: string
  name: string
  path: string
  lastOpened?: string
}

interface WelcomeSidebarProps {
  recentProjects: RecentProject[]
  /** Paths that have been opened in CMD mode — used to show the terminal icon */
  cmdModeProjectPaths?: string[]
  /** Open an existing CMD mode project directly (no dialog) */
  onOpenCmdProject?: (path: string) => void
  /** Promote a CMD mode project to the full IDE (removes from CMD list) */
  onOpenCmdProjectAsIde?: (path: string) => void
  onOpenProject: (path?: string) => void
  onSettings?: () => void
  /** Clear the entire recents list (both CMD and IDE). The caller handles
   *  the confirmation dialog; this component just surfaces the button. */
  onClearRecent?: () => void
}

const WelcomeSidebar: React.FC<WelcomeSidebarProps> = ({
  recentProjects,
  cmdModeProjectPaths = [],
  onOpenCmdProject,
  onOpenCmdProjectAsIde,
  onOpenProject,
  onSettings,
  onClearRecent,
}) => {
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    getAppVersion().then(setAppVersion)
  }, [])

  const truncatePath = (path: string, maxLen = 38) => {
    if (path.length <= maxLen) return path
    const parts = path.split(/[/\\]/)
    if (parts.length <= 3) return '...' + path.slice(-maxLen)
    const sep = path.includes('\\') ? '\\' : '/'
    return parts[0] + sep + '...' + sep + parts.slice(-2).join(sep)
  }

  // Split recent projects into CMD mode and IDE mode groups
  const cmdModePathSet = new Set(cmdModeProjectPaths)
  const cmdProjects = recentProjects.filter(p => cmdModePathSet.has(p.path))
  const ideProjects = recentProjects.filter(p => !cmdModePathSet.has(p.path))

  return (
    <Box
      width="300px"
      minWidth="300px"
      bg="rgba(15, 15, 15, 0.95)"
      backdropFilter="blur(24px)"
      borderRight="1px solid"
      borderColor="rgba(254, 16, 99, 0.15)"
      display="flex"
      flexDirection="column"
      py={8}
      px={5}
      pt={12}
      data-no-drag
      position="relative"
      overflow="hidden"
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
      <Flex alignItems="center" mb={10} position="relative">
        <Box
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
          fontSize="18px"
          fontWeight="800"
          color="white"
          letterSpacing="-0.3px"
        >
          TM Code
        </Heading>
      </Flex>

      {/* Recent projects */}
      <VStack align="stretch" flex={1} overflow="hidden" minH={0}>
        <HStack px={2} mb={3} justify="space-between">
          <HStack gap={2}>
            <Icon color={tokens.colors.text.muted} fontSize="12px">
              <LuClock />
            </Icon>
            <Text
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

          {/* CMD mode projects */}
          {cmdProjects.length > 0 && (
            <>
              <Text
                fontSize="9px"
                fontWeight="700"
                textTransform="uppercase"
                letterSpacing="0.1em"
                color={tokens.colors.accent.purple}
                px={3}
                py="4px"
                opacity={0.7}
              >
                {t('welcome.terminal')}
              </Text>
              {cmdProjects.map((project, index) => (
                <ProjectRow
                  key={project.id || `cmd-${index}`}
                  project={project}
                  isCmdMode
                  truncatePath={truncatePath}
                  onClick={() => project.path && (onOpenCmdProject ? onOpenCmdProject(project.path) : undefined)}
                  onOpenAsIde={onOpenCmdProjectAsIde && project.path ? () => onOpenCmdProjectAsIde(project.path) : undefined}
                />
              ))}
            </>
          )}

          {/* Divider between groups */}
          {cmdProjects.length > 0 && ideProjects.length > 0 && (
            <Box h="1px" bg="rgba(255,255,255,0.05)" mx={3} my={1} />
          )}

          {/* IDE projects */}
          {ideProjects.length > 0 && (
            <>
              {cmdProjects.length > 0 && (
                <Text
                  fontSize="9px"
                  fontWeight="700"
                  textTransform="uppercase"
                  letterSpacing="0.1em"
                  color={tokens.colors.text.disabled}
                  px={3}
                  py="4px"
                  opacity={0.7}
                >
                  {t('welcome.ide')}
                </Text>
              )}
              {ideProjects.map((project, index) => (
                <ProjectRow
                  key={project.id || `ide-${index}`}
                  project={project}
                  isCmdMode={false}
                  truncatePath={truncatePath}
                  onClick={() => project.path && onOpenProject(project.path)}
                />
              ))}
            </>
          )}
        </VStack>
      </VStack>

      {/* Footer — powered by + settings + version */}
      <Flex direction="column" pt={4} mt={4} borderTop="1px solid rgba(255,255,255,0.05)" gap={3}>
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

// ─── Project row (shared between CMD and IDE lists) ─────────────────────

interface ProjectRowProps {
  project: RecentProject
  isCmdMode: boolean
  truncatePath: (path: string, maxLen?: number) => string
  onClick: () => void
  /** If provided, show an "Open in IDE" button */
  onOpenAsIde?: () => void
}

const ProjectRow: React.FC<ProjectRowProps> = ({
  project,
  isCmdMode,
  truncatePath,
  onClick,
  onOpenAsIde,
}) => {
  const timeLabel = relativeTime(project.lastOpened)

  return (
    <Flex
      alignItems="center"
      gap={3}
      px={3}
      py={2}
      borderRadius="8px"
      cursor="pointer"
      transition="all 0.2s ease"
      _hover={{
        bg: 'rgba(255, 255, 255, 0.05)',
        transform: 'translateX(2px)',
      }}
      onClick={onClick}
    >
      {/* Icon */}
      <Flex
        width="28px"
        height="28px"
        borderRadius="6px"
        alignItems="center"
        justifyContent="center"
        bg={isCmdMode ? 'rgba(163, 113, 247, 0.12)' : 'rgba(255, 255, 255, 0.05)'}
        flexShrink={0}
      >
        <Icon
          as={LuFolder}
          fontSize="14px"
          color={isCmdMode ? tokens.colors.accent.purple : tokens.colors.text.secondary}
        />
      </Flex>

      {/* Name + path */}
      <Box flex="1" minW={0}>
        <Text
          fontSize="13px"
          fontWeight="500"
          color={tokens.colors.text.primary}
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
      <Flex gap={1} alignItems="center" opacity={0.5} flexShrink={0}>
        {onOpenAsIde && (
          <Flex
            alignItems="center"
            justifyContent="center"
            width="22px"
            height="22px"
            borderRadius="5px"
            bg="rgba(254, 16, 99, 0.12)"
            opacity={0}
            _groupHover={{ opacity: 1 }}
            transition="opacity 0.15s"
            title={t('welcome.openInIde')}
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenAsIde() }}
          >
            <Icon as={LuFolder} fontSize="12px" color={tokens.colors.accent.primary} />
          </Flex>
        )}
        <Icon as={LuChevronRight} fontSize="12px" color={tokens.colors.text.disabled} />
      </Flex>
    </Flex>
  )
}

export default WelcomeSidebar
