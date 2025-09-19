import { memo, useCallback, useState, useEffect, useRef } from 'react'
import {
  Flex,
  HStack,
  Text,
  IconButton,
  Box,
  ScrollArea} from '@chakra-ui/react'
import {
  FiTerminal,
  FiList,
  FiX,
  FiChevronDown,
  FiAlertTriangle,
  FiXCircle,
  FiInfo,
  FiRefreshCw,
  FiCode
} from 'react-icons/fi'
import { PanelHeader } from './PanelHeader'
import { PanelTab } from './PanelTab'
import TerminalV3 from './TerminalV3'

interface BottomPanelProps {
  isVisible: boolean
  onToggle: () => void
  onClose: () => void
}

interface Problem {
  id: string
  type: 'error' | 'warning' | 'info'
  message: string
  file: string
  line: number
  column: number
}

const TerminalContent = memo(() => {
  const containerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (!containerRef.current) return;
    
    let timeoutId: NodeJS.Timeout;
    
    const resizeObserver = new ResizeObserver((entries) => {
      // Debounce the resize events to prevent too frequent updates
      clearTimeout(timeoutId);
      
      timeoutId = setTimeout(() => {
        for (const entry of entries) {
          // Only dispatch if we have meaningful dimensions
          if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
            const resizeEvent = new CustomEvent('terminalResize', {
              detail: {
                width: entry.contentRect.width,
                height: entry.contentRect.height,
                timestamp: Date.now()
              }
            });
            window.dispatchEvent(resizeEvent);
            break; // Only need to dispatch once per batch
          }
        }
      }, 50); // Small debounce to avoid excessive events
    });
    
    resizeObserver.observe(containerRef.current);
    
    return () => {
      resizeObserver.disconnect();
      clearTimeout(timeoutId);
    };
  }, []);
  
  return (
    <Box ref={containerRef} height="100%" width="100%">
      <TerminalV3 />
    </Box>
  );
})

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
              {Icon && <Icon size={14} color={color} />}
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
      height="100%"
      bg="bg.terminal"
      borderTop="1px solid"
      borderColor="border.glass"
    >
      {/* Header with Tabs */}
      <PanelHeader
        title=""
        compact
        rightControls={
          <>
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
          </>
        }
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
      </PanelHeader>

      {/* Panel Content */}
      <Flex flex="1" direction="column" overflow="hidden">
        {renderPanelContent()}
      </Flex>
    </Flex>
  )
}

export default memo(BottomPanel)