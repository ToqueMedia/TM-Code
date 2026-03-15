import { Box, VStack } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

import {
  DebuggerHeader,
  DebuggerControls,
  DebuggerConfig,
  BreakpointsSection,
  CallStackSection,
  VariablesSection,
  DebugConsole,
  useDebugger
} from './debugger'

interface DebuggerPanelProps {
  isVisible: boolean
  onClose: () => void
}

function DebuggerPanel({ isVisible, onClose }: DebuggerPanelProps) {
  const {
    activeSession,
    breakpoints,
    callStack,
    variables,
    debugConsole,
    isDebugging,
    availableDebuggers,
    showConfig,
    configForm,
    loading,
    expandedSections,
    setShowConfig,
    setConfigForm,
    handleStartDebug,
    handleStopDebug,
    handleDebugAction,
    handleRemoveBreakpoint,
    clearConsole,
    toggleSection
  } = useDebugger()

  if (!isVisible) return null

  return (
    <Box
      position="fixed"
      top="0"
      right="0"
      width="400px"
      height="100vh"
      bg={tokens.colors.bg.app}
      color={tokens.colors.text.primary}
      borderLeft="1px solid"
      borderColor={tokens.colors.border.default}
      zIndex={1000}
      p={4}
      overflowY="auto"
    >
      <VStack gap={4} align="stretch" height="100%">
        <DebuggerHeader onClose={onClose} />

        <DebuggerControls
          activeSession={activeSession}
          isDebugging={isDebugging}
          loading={loading}
          onShowConfig={() => setShowConfig(true)}
          onDebugAction={handleDebugAction}
          onStopDebug={handleStopDebug}
        />

        {showConfig && (
          <DebuggerConfig
            configForm={configForm}
            availableDebuggers={availableDebuggers}
            loading={loading}
            onConfigChange={setConfigForm}
            onStart={handleStartDebug}
            onCancel={() => setShowConfig(false)}
          />
        )}

        <VStack gap={4} align="stretch" flex={1}>
          <BreakpointsSection
            breakpoints={breakpoints}
            expanded={expandedSections.breakpoints}
            onToggle={() => toggleSection('breakpoints')}
            onRemoveBreakpoint={handleRemoveBreakpoint}
          />

          <CallStackSection
            callStack={callStack}
            expanded={expandedSections.callstack}
            onToggle={() => toggleSection('callstack')}
          />

          <VariablesSection
            variables={variables}
            expanded={expandedSections.variables}
            onToggle={() => toggleSection('variables')}
          />

          <DebugConsole
            debugConsole={debugConsole}
            expanded={expandedSections.console}
            onToggle={() => toggleSection('console')}
            onClear={clearConsole}
          />
        </VStack>
      </VStack>
    </Box>
  )
}

export default DebuggerPanel
