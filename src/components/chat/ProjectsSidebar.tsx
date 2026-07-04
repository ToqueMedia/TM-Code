import { memo, useEffect, useCallback } from 'react'
import { Box, Flex, Text, VStack } from '@chakra-ui/react'
import { FiPlus, FiFolder, FiCode, FiClock } from 'react-icons/fi'
import { useProjectStore } from '../../stores/projectStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import type { RecentProject } from '../../types/project'
import { openProjectInEditor, showProjectContextMenu } from '../projectContextMenu'

function formatTimeAgo(dateStr: string): string {
  if (!dateStr) return ''
  // Rust stores last_opened as unix seconds (e.g. "1748112000")
  const date = /^\d+$/.test(dateStr)
    ? new Date(Number(dateStr) * 1000)
    : new Date(dateStr)
  if (isNaN(date.getTime())) return ''
  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  return `${Math.floor(days / 30)}mo`
}

function getProjectInitial(name: string): string {
  return name.charAt(0).toUpperCase()
}

async function switchProject(projectPath: string) {
  const currentProject = useProjectStore.getState().currentProject
  if (currentProject?.path === projectPath) return
  const { useChatStore } = await import('../../stores/chatStore')
  const chatStore = useChatStore.getState()
  if (currentProject) {
    await chatStore.cleanupOnExit(currentProject.path).catch(() => {})
  }
  await useProjectStore.getState().openProject(projectPath)
}

function ProjectsSidebar() {
  const recentProjects = useProjectStore(s => s.recentProjects)
  const currentProject = useProjectStore(s => s.currentProject)
  const loadRecentProjects = useProjectStore(s => s.loadRecentProjects)

  useEffect(() => {
    loadRecentProjects()
  }, [loadRecentProjects])

  const handleOpenInEditor = useCallback((e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    openProjectInEditor(path)
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, project: RecentProject) => {
    e.preventDefault()
    e.stopPropagation()
    showProjectContextMenu(project)
  }, [])

  const handleNewProject = async () => {
    // All projects start from scratch — open folder dialog directly
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, title: t('chat.chooseProject') })
      if (selected) {
        const { useProjectStore } = await import('../../stores/projectStore')
        await useProjectStore.getState().openProject(selected as string)
      }
    } catch { /* cancelled */ }
  }

  return (
    <Flex
      direction="column"
      width="240px"
      minW="240px"
      height="100%"
      bg={tokens.colors.bg.sidebarGlass}
      backdropFilter="blur(20px)"
      borderRight={`1px solid ${tokens.colors.border.sidebar}`}
      overflow="hidden"
    >
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={4}
        py={3}
        flexShrink={0}
      >
        <Text
          fontSize={tokens.fontSize.xs}
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="0.5px"
          color={tokens.colors.text.muted}
        >
          {t('misc.projects')}
        </Text>
        <Flex gap={1}>
          <Box
            as="button"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="24px"
            h="24px"
            borderRadius="6px"
            border={`1px solid ${tokens.colors.border.panel}`}
            color={tokens.colors.text.secondary}
            bg="transparent"
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{
              bg: tokens.colors.accent.primarySubtle,
              borderColor: tokens.colors.accent.primaryMuted,
              color: tokens.colors.accent.primary,
            }}
            onClick={handleNewProject}
            aria-label={t("misc.newProject")}
          >
            <FiPlus size={12} />
          </Box>
        </Flex>
      </Flex>

      {/* Divider */}
      <Box h="1px" bg={tokens.colors.border.sidebarPanel} mx={3} flexShrink={0} />

      {/* Project list */}
      <VStack
        gap={0}
        flex={1}
        overflowY="auto"
        px={2}
        py={2}
        css={{
          '&::-webkit-scrollbar': { width: '4px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': {
            background: tokens.colors.border.panel,
            borderRadius: '2px',
          },
          '&::-webkit-scrollbar-thumb:hover': {
            background: tokens.colors.text.disabled,
          },
        }}
      >
        {recentProjects.length === 0 ? (
          <Flex
            direction="column"
            align="center"
            justify="center"
            py={8}
            gap={3}
          >
            <Flex
              w="40px"
              h="40px"
              borderRadius="12px"
              bg={tokens.colors.bg.whiteSubtle}
              align="center"
              justify="center"
            >
              <FiFolder size={18} color={tokens.colors.text.disabled} />
            </Flex>
            <VStack gap={1}>
              <Text fontSize={tokens.fontSize.sm} color={tokens.colors.text.muted} fontWeight="500">
                {t('misc.noProjectsYet')}
              </Text>
              <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled} textAlign="center" px={4}>
                {t('misc.createFirstProject')}
              </Text>
            </VStack>
            <Box
              as="button"
              display="flex"
              alignItems="center"
              gap="6px"
              px={3}
              py={1.5}
              mt={1}
              borderRadius="8px"
              bg={tokens.colors.accent.primarySubtle}
              border={`1px solid ${tokens.colors.accent.primaryMuted}`}
              color={tokens.colors.accent.primary}
              fontSize={tokens.fontSize.xs}
              fontWeight="500"
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              _hover={{
                bg: tokens.colors.accent.primaryHover,
                borderColor: tokens.colors.accent.primaryBorder,
              }}
              onClick={handleNewProject}
            >
              <FiPlus size={12} />
              {t('misc.newProjectBtn')}
            </Box>
          </Flex>
        ) : (
          recentProjects.map(project => {
            const isActive = currentProject?.path === project.path
            const name = project.name || project.path.split('/').pop() || project.path
            const initial = getProjectInitial(name)
            const timeAgo = formatTimeAgo(project.lastOpened || '')
            const shortPath = project.path.replace(/^\/Users\/[^/]+/, '~')

            return (
              <Box
                key={project.id}
                w="100%"
                borderRadius="10px"
                bg={isActive ? tokens.colors.accent.primarySubtle : 'transparent'}
                transition={`all ${tokens.transition.normal}`}
                _hover={{
                  bg: isActive ? tokens.colors.accent.primaryHover : tokens.colors.bg.hoverSubtle,
                }}
                cursor="pointer"
                onClick={() => switchProject(project.path)}
                onContextMenu={(e) => handleContextMenu(e, project)}
                role="group"
              >
                <Flex align="center" gap={2.5} px={2.5} py={2}>
                  {/* Project avatar */}
                  <Flex
                    w="30px"
                    h="30px"
                    borderRadius="8px"
                    bg={isActive ? tokens.colors.accent.primary : tokens.colors.bg.whiteSubtle}
                    align="center"
                    justify="center"
                    flexShrink={0}
                    transition={`all ${tokens.transition.normal}`}
                    boxShadow={isActive ? `0 2px 8px ${tokens.colors.accent.primaryGlow}` : 'none'}
                  >
                    <Text
                      fontSize="12px"
                      fontWeight="700"
                      color={isActive ? '#fff' : tokens.colors.text.muted}
                      lineHeight="1"
                    >
                      {initial}
                    </Text>
                  </Flex>

                  {/* Project info */}
                  <VStack gap={0} flex={1} alignItems="flex-start" overflow="hidden">
                    <Text
                      fontSize={tokens.fontSize.sm}
                      fontWeight={isActive ? '600' : '400'}
                      color={isActive ? tokens.colors.text.primary : tokens.colors.text.secondary}
                      lineHeight="1.3"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                      w="100%"
                    >
                      {name}
                    </Text>
                    <Flex align="center" gap={1} w="100%">
                      <FiClock size={9} color={tokens.colors.text.disabled} style={{ flexShrink: 0 }} />
                      <Text
                        fontSize="10px"
                        color={tokens.colors.text.disabled}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        {timeAgo}
                      </Text>
                      <Text fontSize="10px" color={tokens.colors.text.disabled} flexShrink={0}>
                        ·
                      </Text>
                      <Text
                        fontSize="10px"
                        color={tokens.colors.text.disabled}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                        flex={1}
                      >
                        {shortPath}
                      </Text>
                    </Flex>
                  </VStack>

                  {/* Open in editor action */}
                  <Box
                    as="button"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    w="24px"
                    h="24px"
                    borderRadius="6px"
                    color={tokens.colors.text.disabled}
                    bg="transparent"
                    opacity={0}
                    flexShrink={0}
                    transition={`all ${tokens.transition.fast}`}
                    _hover={{
                      color: tokens.colors.accent.primary,
                      bg: tokens.colors.bg.whiteSubtle,
                    }}
                    _groupHover={{ opacity: 1 }}
                    onClick={(e: React.MouseEvent) => handleOpenInEditor(e, project.path)}
                    aria-label={t("misc.openInEditor")}
                  >
                    <FiCode size={13} />
                  </Box>
                </Flex>
              </Box>
            )
          })
        )}
      </VStack>

      {/* Footer */}
      <Box
        px={4}
        py={2.5}
        borderTop={`1px solid ${tokens.colors.border.sidebarPanel}`}
        bg={tokens.colors.bg.footerOverlay}
        flexShrink={0}
      >
        <Text fontSize="10px" color={tokens.colors.text.disabled}>
          {recentProjects.length} {recentProjects.length !== 1 ? t('misc.projectCountPlural') : t('misc.projectCount')}
        </Text>
      </Box>
    </Flex>
  )
}

export default memo(ProjectsSidebar)
