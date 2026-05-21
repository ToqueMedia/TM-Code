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
  LuFilePlus2,
  LuFolderOpen,
  LuGitBranch,
  LuFolder,
  LuClock,
  LuChevronRight,
  LuSettings,
  LuTerminal,
  LuEraser,
} from 'react-icons/lu'
import { invoke } from '@/utils/invokeMetrics'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

// Cache the version promise — it never changes during the session.
let versionPromise: Promise<string> | null = null
function getAppVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = invoke<string>('get_app_version')
      .then(v => `v${v}`)
      .catch(() => '')
  }
  return versionPromise
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
  onNewProject: () => void
  onOpenFolder: () => void
  onCloneRepository: () => void
  onCmdMode: () => void
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
  onNewProject,
  onOpenFolder,
  onCloneRepository,
  onCmdMode,
  onOpenCmdProject,
  onOpenCmdProjectAsIde,
  onOpenProject,
  onSettings,
  onClearRecent,
}) => {
  const [appVersion, setAppVersion] = useState('')

  const actionItems = [
    { id: 'new', icon: LuFilePlus2, label: t('welcome.newProject'), color: tokens.colors.accent.primary },
    { id: 'open', icon: LuFolderOpen, label: t('welcome.openProject'), color: tokens.colors.accent.greenBright },
    { id: 'clone', icon: LuGitBranch, label: t('welcome.cloneRepo'), color: tokens.colors.accent.purple },
    { id: 'cmd', icon: LuTerminal, label: t('welcome.terminalMode'), color: tokens.colors.accent.purple },
  ]

  useEffect(() => {
    getAppVersion().then(setAppVersion)
  }, [])

  const handleAction = (id: string) => {
    if (id === 'new') onNewProject()
    else if (id === 'open') onOpenFolder()
    else if (id === 'clone') onCloneRepository()
    else if (id === 'cmd') onCmdMode()
  }

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

      {/* Action buttons */}
      <VStack align="stretch" gap={1} mb={8}>
        <Text
          fontSize="11px"
          fontWeight="700"
          textTransform="uppercase"
          color={tokens.colors.text.muted}
          mb={3}
          letterSpacing="1px"
          px={2}
        >
          {t('welcome.start')}
        </Text>

        {actionItems.map((item) => (
          <Flex
            key={item.id}
            alignItems="center"
            gap={3}
            px={3}
            py={2.5}
            borderRadius="10px"
            cursor="pointer"
            transition="all 0.2s ease"
            _hover={{
              bg: 'rgba(254, 16, 99, 0.08)',
              transform: 'translateX(4px)',
            }}
            onClick={() => handleAction(item.id)}
          >
            <Flex
              width="32px"
              height="32px"
              borderRadius="8px"
              alignItems="center"
              justifyContent="center"
              bg="rgba(255, 255, 255, 0.05)"
              border="1px solid"
              borderColor="rgba(255, 255, 255, 0.08)"
              flexShrink={0}
            >
              <Icon color={item.color} fontSize="15px">
                {React.createElement(item.icon)}
              </Icon>
            </Flex>
            <Text
              fontSize="13px"
              fontWeight="500"
              color={tokens.colors.text.primary}
            >
              {item.label}
            </Text>
          </Flex>
        ))}
      </VStack>

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

          {/* Clear-all button — shown only when there is something to clear.
              Caller owns the confirmation dialog (see projectStore.clearAllRecent). */}
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
                  onClick={() => project.path && (onOpenCmdProject ? onOpenCmdProject(project.path) : onCmdMode())}
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

      {/* Footer — settings + version */}
      <Flex pt={4} mt={4} borderTop="1px solid rgba(255,255,255,0.05)" alignItems="center" justifyContent="space-between" px={2}>
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
        <Text fontSize="10px" color={tokens.colors.text.muted} opacity={0.5}>
          {appVersion}
        </Text>
      </Flex>
    </Box>
  )
}

// ─── ProjectRow ───

interface ProjectRowProps {
  project: RecentProject
  isCmdMode: boolean
  truncatePath: (path: string) => string
  onClick: () => void
  /** For CMD mode rows — promote this project to the full IDE */
  onOpenAsIde?: () => void
}

function ProjectRow({ project, isCmdMode, truncatePath, onClick, onOpenAsIde }: ProjectRowProps) {
  const [hovered, setHovered] = React.useState(false)

  return (
    <Flex
      alignItems="center"
      gap={3}
      px={3}
      py={2}
      borderRadius="8px"
      cursor="pointer"
      transition="all 0.2s ease"
      _hover={{ bg: isCmdMode ? 'rgba(163,113,247,0.07)' : 'rgba(255, 255, 255, 0.05)' }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Icon
        color={isCmdMode ? tokens.colors.accent.purple : tokens.colors.accent.primary}
        fontSize="14px"
        flexShrink={0}
        opacity={0.7}
      >
        {isCmdMode ? <LuTerminal /> : <LuFolder />}
      </Icon>
      <VStack gap={0} alignItems="flex-start" flex={1} minWidth={0}>
        <Text
          fontSize="13px"
          fontWeight="500"
          color={tokens.colors.text.primary}
          lineClamp={1}
        >
          {project.name}
        </Text>
        <Text
          fontSize="10px"
          color={tokens.colors.text.muted}
          lineClamp={1}
          opacity={0.7}
        >
          {truncatePath(project.path)}
        </Text>
      </VStack>

      {/* Escape hatch: open CMD project in full IDE */}
      {isCmdMode && onOpenAsIde && hovered && (
        <Box
          as="button"
          fontSize="9px"
          fontWeight="700"
          color={tokens.colors.text.disabled}
          _hover={{ color: tokens.colors.accent.primary }}
          px="5px"
          py="2px"
          border="1px solid rgba(255,255,255,0.1)"
          borderRadius="3px"
          transition="all 0.1s"
          textTransform="uppercase"
          letterSpacing="0.08em"
          flexShrink={0}
          onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenAsIde() }}
          title={t('welcome.openInIde')}
        >
          {t('welcome.ide')}
        </Box>
      )}

      {(!isCmdMode || !onOpenAsIde || !hovered) && (
        <Icon color={tokens.colors.text.muted} fontSize="12px" opacity={hovered ? 0.6 : 0} transition="opacity 0.2s" flexShrink={0}>
          <LuChevronRight />
        </Icon>
      )}
    </Flex>
  )
}

export default WelcomeSidebar
