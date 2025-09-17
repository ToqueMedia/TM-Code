import React, { memo, useCallback, useState } from 'react'
import {
  Flex,
  HStack,
  Text,
  IconButton,
  Box,
  ScrollArea,
  Badge,
  Button
} from '@chakra-ui/react'
import {
  FiTerminal,
  FiList,
  FiX,
  FiChevronDown,
  FiMaximize2,
  FiMinus,
  FiAlertTriangle,
  FiXCircle,
  FiInfo,
  FiRefreshCw,
  FiCode
} from 'react-icons/fi'

interface BottomPanelProps {
  isVisible: boolean
  onToggle: () => void
  onClose: () => void
}

interface PanelTabProps {
  id: string
  label: string
  icon: React.ElementType
  isActive: boolean
  badge?: number
  badgeVariant?: 'error' | 'warning' | 'info'
  onClick: () => void
}

const PanelTab = memo<PanelTabProps>(({ 
  id, 
  label, 
  icon: Icon, 
  isActive, 
  badge,
  badgeVariant = 'info',
  onClick 
}) => (
  <Button
    variant="ghost"
    size="sm"
    height="32px"
    px={3}
    bg={isActive ? 'whiteAlpha.100' : 'transparent'}
    borderBottom={isActive ? '2px solid' : 'none'}
    borderColor={isActive ? 'blue.500' : 'transparent'}
    borderRadius="0"
    color={isActive ? 'text.primary' : 'text.secondary'}
    _hover={{
      bg: isActive ? 'whiteAlpha.100' : 'whiteAlpha.050',
      color: 'text.primary'
    }}
    onClick={onClick}
    data-panel={id}
  >
    <HStack gap={2}>
      <Icon size={14} />
      <Text fontSize="xs" fontWeight="medium">{label}</Text>
      {badge && badge > 0 && (
        <Badge
          size="sm"
          colorPalette={badgeVariant === 'error' ? 'red' : badgeVariant === 'warning' ? 'orange' : 'blue'}
          fontSize="xs"
        >
          {badge > 99 ? '99+' : badge}
        </Badge>
      )}
    </HStack>
  </Button>
))

PanelTab.displayName = 'PanelTab'

interface Problem {
  id: string
  type: 'error' | 'warning' | 'info'
  message: string
  file: string
  line: number
  column: number
}

const TerminalContent = memo(() => (
  <ScrollArea.Root flex="1">
    <ScrollArea.Viewport p={3} fontFamily="mono" fontSize="sm">
      <Text color="#58a6ff" mb={1}>
        Microsoft Windows [Version 10.0.19044.2728]
      </Text>
      <Text color="text.muted" mb={2}>
        (c) Microsoft Corporation. All rights reserved.
      </Text>
      <Text mb={1}>
        <Text as="span" color="#a371f7">C:\Users\dev&gt;</Text>{' '}
        <Text as="span" color="text.primary">npm run dev</Text>
      </Text>
      <Text color="#2ea043" mb={1}>
        ✓ Starting development server...
      </Text>
      <Text color="#58a6ff" mb={1}>
        ℹ Local server running at http://localhost:3000
      </Text>
      <Text color="#f77f00" mb={1}>
        ⚠ Warning: Some dependencies are outdated
      </Text>
      <Text color="#2ea043" mb={1}>
        ✓ Compiled successfully in 2.3s
      </Text>
      <Text>
        <Text as="span" color="#a371f7">C:\Users\dev&gt;</Text>{' '}
        <Box as="span" display="inline-block" w="8px" h="16px" bg="text.primary" animation="blink 1s infinite" />
      </Text>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar orientation="vertical">
      <ScrollArea.Thumb />
    </ScrollArea.Scrollbar>
  </ScrollArea.Root>
))

TerminalContent.displayName = 'TerminalContent'

const OutputContent = memo(() => (
  <ScrollArea.Root flex="1">
    <ScrollArea.Viewport p={3} fontFamily="mono" fontSize="sm">
      <Text color="text.muted" mb={2}>
        [Extension Host] Starting extension host process...
      </Text>
      <Text color="#58a6ff" mb={1}>
        [Info] TypeScript Language Server started
      </Text>
      <Text color="#2ea043" mb={1}>
        [Info] Code formatting enabled
      </Text>
      <Text color="#f77f00" mb={1}>
        [Warn] Extension 'deprecated-ext' is deprecated
      </Text>
      <Text color="text.muted" mb={1}>
        [Debug] Watching for file changes...
      </Text>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar orientation="vertical">
      <ScrollArea.Thumb />
    </ScrollArea.Scrollbar>
  </ScrollArea.Root>
))

OutputContent.displayName = 'OutputContent'

const ProblemsContent = memo(() => {
  const problems: Problem[] = [
    {
      id: '1',
      type: 'error',
      message: "Cannot find module 'react'",
      file: 'src/App.tsx',
      line: 1,
      column: 18
    },
    {
      id: '2',
      type: 'warning',
      message: 'Unused variable: data',
      file: 'src/components/Header.tsx',
      line: 12,
      column: 7
    },
    {
      id: '3',
      type: 'info',
      message: 'Consider using const assertion',
      file: 'src/utils/constants.ts',
      line: 5,
      column: 14
    }
  ]

  const getIcon = (type: Problem['type']) => {
    switch (type) {
      case 'error': return FiXCircle
      case 'warning': return FiAlertTriangle
      case 'info': return FiInfo
    }
  }

  const getColor = (type: Problem['type']) => {
    switch (type) {
      case 'error': return '#f85149'
      case 'warning': return '#f77f00'
      case 'info': return '#58a6ff'
    }
  }

  return (
    <ScrollArea.Root flex="1">
      <ScrollArea.Viewport>
        {problems.map((problem) => {
          const Icon = getIcon(problem.type)
          const color = getColor(problem.type)
          
          return (
            <Flex
              key={problem.id}
              align="center"
              px={3}
              py={2}
              borderBottom="1px solid"
              borderColor="border.glass"
              cursor="pointer"
              _hover={{ bg: 'whiteAlpha.050' }}
            >
              <Icon size={14} color={color} />
              <Box ml={3} flex="1" minW="0">
                <Text fontSize="sm" color="text.primary" mb={1}>
                  {problem.message}
                </Text>
                <Text fontSize="xs" color="text.muted">
                  {problem.file}:{problem.line}:{problem.column}
                </Text>
              </Box>
            </Flex>
          )
        })}
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar orientation="vertical">
        <ScrollArea.Thumb />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  )
})

ProblemsContent.displayName = 'ProblemsContent'

const DebugConsoleContent = memo(() => (
  <ScrollArea.Root flex="1">
    <ScrollArea.Viewport p={3} fontFamily="mono" fontSize="sm">
      <Text color="text.muted" mb={1}>
        Debug session started
      </Text>
      <Text color="#58a6ff" mb={1}>
        Breakpoint hit: App.tsx:25
      </Text>
      <Text color="text.primary" mb={1}>
        &gt; console.log(user)
      </Text>
      <Text color="#2ea043" mb={1}>
        {`{ id: 1, name: "John Doe", email: "john@example.com" }`}
      </Text>
      <Text color="text.muted">
        Ready for evaluation
      </Text>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar orientation="vertical">
      <ScrollArea.Thumb />
    </ScrollArea.Scrollbar>
  </ScrollArea.Root>
))

DebugConsoleContent.displayName = 'DebugConsoleContent'

function BottomPanel({ isVisible, onToggle, onClose }: BottomPanelProps) {
  const [activePanel, setActivePanel] = useState('terminal')
  const [isMaximized, setIsMaximized] = useState(false)

  const panels = [
    {
      id: 'problems',
      label: 'Problems',
      icon: FiList,
      badge: 3,
      badgeVariant: 'error' as const
    },
    {
      id: 'output',
      label: 'Output',
      icon: FiRefreshCw,
    },
    {
      id: 'debug-console',
      label: 'Debug Console',
      icon: FiCode,
    },
    {
      id: 'terminal',
      label: 'Terminal',
      icon: FiTerminal,
    }
  ]

  const handlePanelChange = useCallback((panelId: string) => {
    setActivePanel(panelId)
  }, [])

  const handleMaximize = useCallback(() => {
    setIsMaximized(!isMaximized)
  }, [isMaximized])

  const renderPanelContent = () => {
    switch (activePanel) {
      case 'terminal':
        return <TerminalContent />
      case 'output':
        return <OutputContent />
      case 'problems':
        return <ProblemsContent />
      case 'debug-console':
        return <DebugConsoleContent />
      default:
        return <TerminalContent />
    }
  }

  if (!isVisible) return null

  return (
    <Flex
      direction="column"
      height={isMaximized ? '70vh' : '250px'}
      bg="bg.terminal"
      borderTop="1px solid"
      borderColor="border.glass"
    >
      {/* Header with Tabs */}
      <Flex
        align="center"
        justify="space-between"
        height="32px"
        bg="bg.sidebar"
        borderBottom="1px solid"
        borderColor="border.glass"
      >
        <HStack gap={0}>
          {panels.map((panel) => (
            <PanelTab
              key={panel.id}
              id={panel.id}
              label={panel.label}
              icon={panel.icon}
              isActive={activePanel === panel.id}
              badge={panel.badge}
              badgeVariant={panel.badgeVariant}
              onClick={() => handlePanelChange(panel.id)}
            />
          ))}
        </HStack>

        <HStack gap={1} pr={2}>
          <IconButton
            aria-label="Toggle maximize"
            variant="ghost"
            size="xs"
            color="text.secondary"
            onClick={handleMaximize}
          >
            {isMaximized ? <FiMinus size={12} /> : <FiMaximize2 size={12} />}
          </IconButton>
          <IconButton
            aria-label="Toggle panel"
            variant="ghost"
            size="xs"
            color="text.secondary"
            onClick={onToggle}
          >
            <FiChevronDown size={12} />
          </IconButton>
          <IconButton
            aria-label="Close panel"
            variant="ghost"
            size="xs"
            color="text.secondary"
            onClick={onClose}
          >
            <FiX size={12} />
          </IconButton>
        </HStack>
      </Flex>

      {/* Panel Content */}
      <Flex flex="1" direction="column" overflow="hidden">
        {renderPanelContent()}
        
        {/* Terminal Input (only for terminal) */}
        {activePanel === 'terminal' && (
          <Flex
            align="center"
            px={3}
            py={2}
            borderTop="1px solid"
            borderColor="border.glass"
            bg="rgba(255, 255, 255, 0.02)"
          >
            <Text
              as="span"
              color="#a371f7"
              mr={2}
              fontFamily="mono"
              fontSize="sm"
            >
              C:\Users\dev&gt;
            </Text>
            <Box
              flex="1"
              height="20px"
              bg="transparent"
              outline="none"
              contentEditable
              fontFamily="mono"
              fontSize="sm"
              color="text.primary"
              _focus={{ outline: 'none' }}
            />
          </Flex>
        )}
      </Flex>
    </Flex>
  )
}

export default memo(BottomPanel)