import { memo, useCallback, useState, useEffect, useRef } from 'react'
import {
  Flex,
  HStack,
  IconButton,
  Box} from '@chakra-ui/react'
import {
  FiTerminal,
  FiList,
  FiX,
  FiChevronDown,
  FiRefreshCw,
  FiCode
} from 'react-icons/fi'
import { PanelHeader } from './PanelHeader'
import { PanelTab } from './PanelTab'
import TerminalV3 from './TerminalV3'
import ProblemsContent from './ProblemsContent'
import OutputContent from './OutputContent'
import DebugConsoleContent from './DebugConsoleContent'

interface BottomPanelProps {
  isVisible: boolean
  onToggle: () => void
  onClose: () => void
}

const TerminalContent = memo(() => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let timeoutId: NodeJS.Timeout;

    const resizeObserver = new ResizeObserver((entries) => {
      clearTimeout(timeoutId);

      timeoutId = setTimeout(() => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
            const resizeEvent = new CustomEvent('terminalResize', {
              detail: {
                width: entry.contentRect.width,
                height: entry.contentRect.height,
                timestamp: Date.now()
              }
            });
            window.dispatchEvent(resizeEvent);
            break;
          }
        }
      }, 50);
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
