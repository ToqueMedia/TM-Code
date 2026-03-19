import { memo } from 'react'
import { Flex, Box } from '@chakra-ui/react'
import { FiMessageSquare, FiFolder, FiTerminal, FiBox } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'

export type SidebarPanel = 'explorer' | 'containers' | null

interface ToolbarButtonProps {
  icon: React.ReactNode
  label: string
  isActive?: boolean
  onClick: () => void
}

function ToolbarButton({ icon, label, isActive, onClick }: ToolbarButtonProps) {
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
  const toggle = (panel: 'explorer' | 'containers') => {
    onSelectPanel(activePanel === panel ? null : panel)
  }

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
          icon={<FiMessageSquare size={17} />}
          label="Back to Chat"
          onClick={onBackToChat}
        />
        <Box w="20px" h="1px" bg={tokens.colors.border.subtle} my={0.5} />
        <ToolbarButton
          icon={<FiFolder size={17} />}
          label="Explorer"
          isActive={activePanel === 'explorer'}
          onClick={() => toggle('explorer')}
        />
        <ToolbarButton
          icon={<FiBox size={17} />}
          label="Containers"
          isActive={activePanel === 'containers'}
          onClick={() => toggle('containers')}
        />
      </Flex>

      <Flex direction="column" gap={0.5} align="center" pb={1}>
        <ToolbarButton
          icon={<FiTerminal size={17} />}
          label="Terminal"
          isActive={isBottomPanelVisible}
          onClick={onToggleBottomPanel}
        />
      </Flex>
    </Flex>
  )
}

export default memo(EditorToolbar)
