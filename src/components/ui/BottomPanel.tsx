import { memo, useCallback, useState, useEffect, useRef } from 'react'
import {
  Flex,
  HStack,
  IconButton,
  Box
} from '@chakra-ui/react'
import {
  FiTerminal,
  FiList,
  FiX,
  FiMinus,
  FiRefreshCw,
  FiCode
} from 'react-icons/fi'
import { PanelTab } from './PanelTab'
import TerminalV3 from './TerminalV3'
import ProblemsContent from './ProblemsContent'
import OutputContent from './OutputContent'
import DebugConsoleContent from './DebugConsoleContent'
import { useProblemsStore, selectErrorCount, selectWarningCount } from '@/stores/problemsStore'
import { tokens } from '@/theme/tokens'

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
  const errorCount = useProblemsStore(selectErrorCount)
  const warningCount = useProblemsStore(selectWarningCount)
  const totalProblems = errorCount + warningCount

  const panels = [
    {
      id: 'terminal',
      label: 'Terminal',
      icon: FiTerminal,
    },
    {
      id: 'problems',
      label: 'Problems',
      icon: FiList,
      badge: totalProblems > 0 ? totalProblems : undefined,
      badgeVariant: errorCount > 0 ? 'error' as const : 'warning' as const
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
      bg={tokens.colors.bg.terminal}
    >
      {/* Header with Tabs */}
      <Flex
        align="center"
        justify="space-between"
        height="28px"
        flexShrink={0}
        borderBottom={`1px solid ${tokens.colors.border.default}`}
        bg={tokens.colors.bg.panel}
        px={1}
      >
        <HStack gap={0} height="100%">
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

        <HStack gap={0.5} pr={1}>
          <IconButton
            aria-label="Minimize panel"
            title="Minimize panel"
            variant="ghost"
            size="xs"
            color={tokens.colors.text.muted}
            _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
            onClick={onToggle}
            borderRadius="4px"
            width="24px"
            height="24px"
            minW="24px"
          >
            <FiMinus size={13} />
          </IconButton>
          <IconButton
            aria-label="Close panel"
            title="Close panel"
            variant="ghost"
            size="xs"
            color={tokens.colors.text.muted}
            _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
            onClick={onClose}
            borderRadius="4px"
            width="24px"
            height="24px"
            minW="24px"
          >
            <FiX size={13} />
          </IconButton>
        </HStack>
      </Flex>

      {/* Panel Content */}
      <Flex flex="1" direction="column" overflow="hidden">
        {renderPanelContent()}
      </Flex>
    </Flex>
  )
}

export default memo(BottomPanel)
