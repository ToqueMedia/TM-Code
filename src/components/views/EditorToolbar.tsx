import { memo, useEffect } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { VscComment, VscFiles, VscTerminal, VscSourceControl, VscSearch } from 'react-icons/vsc'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { acquireGitStatusPolling } from '@/services/gitStatusPoller'
import { useGitStatusStore } from '@/stores/gitStatusStore'
import { useCurrentProject } from '@/hooks/useProjectState'

export type SidebarPanel = 'explorer' | 'search' | 'sourceControl' | null

interface ToolbarButtonProps {
  icon: React.ReactNode
  label: string
  isActive?: boolean
  badge?: number
  onClick: () => void
}

function ToolbarButton({ icon, label, isActive, badge, onClick }: ToolbarButtonProps) {
  return (
    <Box
      as="button"
      display="flex"
      alignItems="center"
      justifyContent="center"
      width="34px"
      height="34px"
      borderRadius="6px"
      color={isActive ? tokens.colors.text.primary : tokens.colors.text.muted}
      bg={isActive ? tokens.colors.bg.whiteSubtle : 'transparent'}
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      title={label}
      _hover={{
        bg: tokens.colors.bg.whiteSubtle,
        color: tokens.colors.text.primary,
      }}
      onClick={onClick}
      position="relative"
    >
      {icon}
      {isActive && (
        <Box
          position="absolute"
          left="0"
          top="6px"
          bottom="6px"
          width="2px"
          bg={tokens.colors.accent.primary}
          borderRadius="0 2px 2px 0"
        />
      )}
      {badge != null && badge > 0 && (
        <Box
          position="absolute"
          bottom="3px"
          right="3px"
          minW="14px"
          h="14px"
          borderRadius={tokens.radius.full}
          bg={tokens.colors.accent.primary}
          display="flex"
          alignItems="center"
          justifyContent="center"
          px="3px"
        >
          <Text
            fontSize="9px"
            fontWeight="700"
            color="#fff"
            fontFamily={tokens.fontFamily.mono}
            lineHeight="1"
          >
            {badge > 99 ? '99+' : badge}
          </Text>
        </Box>
      )}
    </Box>
  )
}

interface EditorToolbarProps {
  activePanel: SidebarPanel
  isBottomPanelVisible: boolean
  onSelectPanel: (panel: SidebarPanel) => void
  onToggleBottomPanel: () => void
  onBackToChat: () => void
}

function EditorToolbar({
  activePanel,
  isBottomPanelVisible,
  onSelectPanel,
  onToggleBottomPanel,
  onBackToChat,
}: EditorToolbarProps) {
  const toggle = (panel: 'explorer' | 'search' | 'sourceControl') => {
    onSelectPanel(activePanel === panel ? null : panel)
  }

  const currentProject = useCurrentProject()
  // Badge count comes from the shared git-status store — this used to be a
  // second 6s setInterval firing duplicate git_status_files IPCs alongside
  // the SourceControlPanel's own poll (see services/gitStatusPoller.ts).
  const gitCount = useGitStatusStore(s => s.files.length)

  useEffect(() => {
    if (!currentProject?.path) return
    return acquireGitStatusPolling(currentProject.path)
  }, [currentProject?.path])

  return (
    <Flex
      direction="column"
      width="40px"
      bg={tokens.colors.bg.activitybar}
      borderRight={`1px solid ${tokens.colors.border.sidebarPanel}`}
      py={1}
      gap={0.5}
      align="center"
      flexShrink={0}
      justifyContent="space-between"
      height="100%"
    >
      <Flex direction="column" gap={0.5} align="center">
        {/* Back to Chat — top icon */}
        <ToolbarButton
          icon={<VscComment size={16} />}
          label={t("view.backToChat")}
          onClick={onBackToChat}
        />
        <Box w="20px" h="1px" bg={tokens.colors.border.subtle} my={0.5} />
        <ToolbarButton
          icon={<VscFiles size={16} />}
          label={t("view.explorer")}
          isActive={activePanel === 'explorer'}
          onClick={() => toggle('explorer')}
        />
        <ToolbarButton
          icon={<VscSearch size={16} />}
          label={t("search.title")}
          isActive={activePanel === 'search'}
          onClick={() => toggle('search')}
        />
        <ToolbarButton
          icon={<VscSourceControl size={16} />}
          label={t("view.sourceControl")}
          isActive={activePanel === 'sourceControl'}
          badge={gitCount}
          onClick={() => toggle('sourceControl')}
        />
      </Flex>

      <Flex direction="column" gap={0.5} align="center" pb={1}>
        <ToolbarButton
          icon={<VscTerminal size={16} />}
          label={t("view.terminal")}
          isActive={isBottomPanelVisible}
          onClick={onToggleBottomPanel}
        />
      </Flex>
    </Flex>
  )
}

export default memo(EditorToolbar)
