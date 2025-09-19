import { useState, useEffect, useCallback } from 'react'
import {
  Box,
  VStack,
  HStack,
  Text,
  IconButton,
  Button,
  Input,
  Badge
} from '@chakra-ui/react'
import {
  FiPlay,
  FiPause,
  FiSquare,
  FiSkipForward,
  FiArrowDown,
  FiArrowUp,
  FiCircle,
  FiTrash2,
  FiTool,
  FiX,
  FiChevronDown
} from 'react-icons/fi'

import DebuggerService, {
  DebugSession,
  DebugBreakpoint,
  DebugStackFrame,
  DebugVariable,
  DebugConfiguration,
  DebuggerEvent
} from '../services/debuggerService'

interface DebuggerPanelProps {
  isVisible: boolean
  onClose: () => void
}

interface DebugConfigForm {
  name: string
  program: string
  args: string
  cwd: string
  debugType: string
}

function DebuggerPanel({ isVisible, onClose }: DebuggerPanelProps) {
  const [debuggerService] = useState(() => DebuggerService.getInstance())
  const [, setSessions] = useState<DebugSession[]>([])
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [breakpoints, setBreakpoints] = useState<DebugBreakpoint[]>([])
  const [callStack, setCallStack] = useState<DebugStackFrame[]>([])
  const [variables, setVariables] = useState<DebugVariable[]>([])
  const [debugConsole, setDebugConsole] = useState<string[]>([])
  const [isDebugging, setIsDebugging] = useState(false)
  const [availableDebuggers, setAvailableDebuggers] = useState<Record<string, string>>({})
  const [showConfig, setShowConfig] = useState(false)
  const [configForm, setConfigForm] = useState<DebugConfigForm>({
    name: 'Node.js Debug',
    program: '',
    args: '',
    cwd: '',
    debugType: 'node'
  })
  const [loading, setLoading] = useState(false)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    breakpoints: true,
    callstack: false,
    variables: false,
    console: true
  })

  const addConsoleMessage = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setDebugConsole(prev => [...prev, `[${timestamp}] ${message}`])
  }, [])

  // Load available debuggers on component mount
  useEffect(() => {
    async function loadDebuggers() {
      try {
        const debuggers = await debuggerService.checkDebuggerAvailability()
        setAvailableDebuggers(debuggers)
      } catch (error) {
        console.error('Failed to load debuggers:', error)
        addConsoleMessage('Failed to load available debuggers')
      }
    }

    loadDebuggers()
  }, [debuggerService, addConsoleMessage])

  // Set up debugger event listeners
  useEffect(() => {
    function handleDebuggerEvent(event: DebuggerEvent) {
      switch (event.type) {
        case 'session-started':
          addConsoleMessage(`Debug session started: ${event.session_id}`)
          refreshSessions()
          break
        case 'session-stopped':
          addConsoleMessage(`Debug session stopped: ${event.session_id}`)
          setIsDebugging(false)
          refreshSessions()
          break
        case 'execution-paused':
          addConsoleMessage('Execution paused')
          setIsDebugging(false)
          refreshDebugInfo()
          break
        case 'execution-continued':
          addConsoleMessage('Execution continued')
          setIsDebugging(true)
          break
        case 'step-completed':
          addConsoleMessage(`Step completed: ${event.data?.type}`)
          refreshDebugInfo()
          break
        case 'breakpoint-hit':
          addConsoleMessage(`Breakpoint hit: ${event.data?.file}:${event.data?.line}`)
          setIsDebugging(false)
          refreshDebugInfo()
          break
      }
    }

    debuggerService.addEventListener(handleDebuggerEvent)

    return () => {
      debuggerService.removeEventListener(handleDebuggerEvent)
    }
  }, [debuggerService])

  // Set up keyboard shortcut listeners
  useEffect(() => {
    const handleDebuggerStart = () => {
      if (activeSession) {
        handleDebugAction(isDebugging ? 'pause' : 'continue')
      } else {
        setShowConfig(true)
      }
    }

    const handleDebuggerStop = () => {
      if (activeSession) {
        handleStopDebug()
      }
    }

    const handleToggleBreakpoint = () => {
      // This would need to be coordinated with Monaco Editor
      // For now, just log that the shortcut was triggered
      addConsoleMessage('Toggle breakpoint shortcut triggered (F9)')
    }

    const handleStepOver = () => {
      if (activeSession && !isDebugging) {
        handleDebugAction('step-over')
      }
    }

    const handleStepInto = () => {
      if (activeSession && !isDebugging) {
        handleDebugAction('step-into')
      }
    }

    const handleStepOut = () => {
      if (activeSession && !isDebugging) {
        handleDebugAction('step-out')
      }
    }

    window.addEventListener('debugger:start', handleDebuggerStart)
    window.addEventListener('debugger:stop', handleDebuggerStop)
    window.addEventListener('debugger:toggle-breakpoint', handleToggleBreakpoint)
    window.addEventListener('debugger:step-over', handleStepOver)
    window.addEventListener('debugger:step-into', handleStepInto)
    window.addEventListener('debugger:step-out', handleStepOut)

    return () => {
      window.removeEventListener('debugger:start', handleDebuggerStart)
      window.removeEventListener('debugger:stop', handleDebuggerStop)
      window.removeEventListener('debugger:toggle-breakpoint', handleToggleBreakpoint)
      window.removeEventListener('debugger:step-over', handleStepOver)
      window.removeEventListener('debugger:step-into', handleStepInto)
      window.removeEventListener('debugger:step-out', handleStepOut)
    }
  }, [activeSession, isDebugging, addConsoleMessage])

  const refreshSessions = useCallback(async () => {
    try {
      const allSessions = await debuggerService.getDebugSessions()
      setSessions(allSessions)
    } catch (error) {
      console.error('Failed to refresh sessions:', error)
    }
  }, [debuggerService])

  const refreshDebugInfo = useCallback(async () => {
    if (!activeSession) return

    try {
      const [breakpointsData, callStackData] = await Promise.all([
        debuggerService.getBreakpoints(activeSession),
        debuggerService.getCallStack(activeSession)
      ])

      setBreakpoints(breakpointsData)
      setCallStack(callStackData)

      // Load variables for the current frame
      if (callStackData.length > 0) {
        const vars = await debuggerService.getVariables(activeSession, callStackData[0].id)
        setVariables(vars)
      }
    } catch (error) {
      console.error('Failed to refresh debug info:', error)
    }
  }, [activeSession, debuggerService])

  const handleStartDebug = async () => {
    if (!configForm.program.trim()) {
      addConsoleMessage('Error: Program path is required')
      return
    }

    setLoading(true)
    try {
      const config: DebugConfiguration = {
        name: configForm.name,
        program: configForm.program,
        args: configForm.args ? configForm.args.split(' ') : [],
        cwd: configForm.cwd || './',
        env: {},
        debug_type: configForm.debugType
      }

      const sessionId = await debuggerService.startDebugSession(config)
      setActiveSession(sessionId)
      setShowConfig(false)
      
      // Launch the debug session
      await debuggerService.launchDebugSession(sessionId)
      setIsDebugging(true)
      
      addConsoleMessage(`Started debugging: ${config.name}`)
      
      // Refresh debug info
      await refreshDebugInfo()
    } catch (error) {
      console.error('Failed to start debugging:', error)
      addConsoleMessage(`Debug Error: Failed to start debugging: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  const handleStopDebug = async () => {
    if (!activeSession) return

    setLoading(true)
    try {
      await debuggerService.stopDebugSession(activeSession)
      setActiveSession(null)
      setIsDebugging(false)
      setBreakpoints([])
      setCallStack([])
      setVariables([])
      addConsoleMessage('Debug session stopped')
    } catch (error) {
      console.error('Failed to stop debugging:', error)
      addConsoleMessage(`Error: Failed to stop debugging: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  const handleDebugAction = async (action: string) => {
    if (!activeSession) return

    setLoading(true)
    try {
      switch (action) {
        case 'continue':
          await debuggerService.debugContinue(activeSession)
          setIsDebugging(true)
          break
        case 'pause':
          await debuggerService.debugPause(activeSession)
          setIsDebugging(false)
          break
        case 'step-over':
          await debuggerService.debugStepOver(activeSession)
          break
        case 'step-into':
          await debuggerService.debugStepInto(activeSession)
          break
        case 'step-out':
          await debuggerService.debugStepOut(activeSession)
          break
      }
    } catch (error) {
      console.error(`Failed to ${action}:`, error)
      addConsoleMessage(`Debug Error: Failed to ${action}: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveBreakpoint = async (breakpointId: string) => {
    if (!activeSession) return

    try {
      await debuggerService.removeBreakpoint(activeSession, breakpointId)
      await refreshDebugInfo()
      addConsoleMessage(`Breakpoint removed: ${breakpointId}`)
    } catch (error) {
      console.error('Failed to remove breakpoint:', error)
    }
  }

  const clearConsole = () => {
    setDebugConsole([])
  }

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }))
  }

  if (!isVisible) return null

  return (
    <Box 
      position="fixed"
      top="0"
      right="0"
      width="400px"
      height="100vh"
      bg="gray.900"
      color="white"
      borderLeft="1px solid"
      borderColor="gray.700"
      zIndex={1000}
      p={4}
      overflowY="auto"
    >
      <VStack 
        gap={4} 
        align="stretch" 
        height="100%"
      >
        {/* Header */}
        <HStack 
          justify="space-between"
          pb={2}
          borderBottom="1px solid"
          borderColor="gray.700"
        >
          <HStack>
            <FiTool />
            <Text 
              fontSize="lg" 
              fontWeight="bold"
            >
              Debugger
            </Text>
          </HStack>
          <IconButton
            aria-label="Close debugger"
            size="sm"
            variant="ghost"
            onClick={onClose}
          >
            <FiX />
          </IconButton>
        </HStack>

        {/* Debug Controls */}
        <VStack 
          gap={3} 
          align="stretch"
        >
          <HStack>
            {!activeSession ? (
              <Button
                size="sm"
                onClick={() => setShowConfig(true)}
                disabled={loading}
                bg="green.600"
                color="white"
                _hover={{ bg: "green.700" }}
              >
                <FiPlay style={{ marginRight: '8px' }} />
                Start Debugging
              </Button>
            ) : (
              <HStack 
                gap={2}
              >
                <IconButton
                  aria-label={isDebugging ? "Pause" : "Continue"}
                  size="sm"
                  onClick={() => handleDebugAction(isDebugging ? 'pause' : 'continue')}
                  disabled={loading}
                  bg={isDebugging ? "orange.600" : "green.600"}
                  color="white"
                >
                  {isDebugging ? <FiPause /> : <FiPlay />}
                </IconButton>
                
                <IconButton
                  aria-label="Stop debugging"
                  size="sm"
                  onClick={handleStopDebug}
                  disabled={loading}
                  bg="red.600"
                  color="white"
                >
                  <FiSquare />
                </IconButton>

                <IconButton
                  aria-label="Step over"
                  size="sm"
                  onClick={() => handleDebugAction('step-over')}
                  disabled={isDebugging || loading}
                >
                  <FiSkipForward />
                </IconButton>

                <IconButton
                  aria-label="Step into"
                  size="sm"
                  onClick={() => handleDebugAction('step-into')}
                  disabled={isDebugging || loading}
                >
                  <FiArrowDown />
                </IconButton>

                <IconButton
                  aria-label="Step out"
                  size="sm"
                  onClick={() => handleDebugAction('step-out')}
                  disabled={isDebugging || loading}
                >
                  <FiArrowUp />
                </IconButton>
              </HStack>
            )}
          </HStack>

          {/* Status */}
          {activeSession && (
            <HStack>
              <Badge 
                colorScheme={isDebugging ? "green" : "orange"}
              >
                {isDebugging ? "Running" : "Paused"}
              </Badge>
              <Text 
                fontSize="sm" 
                color="gray.400"
              >
                Session: {activeSession.slice(0, 8)}...
              </Text>
            </HStack>
          )}
        </VStack>

        {/* Debug Configuration */}
        {showConfig && (
          <Box 
            p={4} 
            bg="gray.800" 
            borderRadius="md" 
            border="1px solid" 
            borderColor="gray.600"
          >
            <VStack 
              gap={3} 
              align="stretch"
            >
              <Text 
                fontSize="md" 
                fontWeight="semibold"
              >
                Debug Configuration
              </Text>

              {Object.keys(availableDebuggers).length === 0 && (
                <Text 
                  fontSize="sm" 
                  color="orange.400"
                >
                  ⚠️ No debuggers available. Please install Node.js.
                </Text>
              )}

              <Input
                placeholder="Configuration name"
                value={configForm.name}
                onChange={(e) => setConfigForm(prev => ({ ...prev, name: e.target.value }))}
                bg="gray.700"
                border="1px solid"
                borderColor="gray.600"
              />

              <Input
                placeholder="Program path (e.g., ./src/index.js)"
                value={configForm.program}
                onChange={(e) => setConfigForm(prev => ({ ...prev, program: e.target.value }))}
                bg="gray.700"
                border="1px solid"
                borderColor="gray.600"
              />

              <Input
                placeholder="Arguments (space separated)"
                value={configForm.args}
                onChange={(e) => setConfigForm(prev => ({ ...prev, args: e.target.value }))}
                bg="gray.700"
                border="1px solid"
                borderColor="gray.600"
              />

              <HStack 
                justify="flex-end"
              >
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowConfig(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleStartDebug}
                  disabled={Object.keys(availableDebuggers).length === 0 || loading}
                  bg="green.600"
                  color="white"
                  _hover={{ bg: "green.700" }}
                >
                  Start
                </Button>
              </HStack>
            </VStack>
          </Box>
        )}

        {/* Debug Info Sections */}
        <VStack 
          gap={4}
          align="stretch"
          flex={1}
        >
          {/* Breakpoints */}
          <Box>
            <HStack 
              justify="space-between"
              mb={2}
              cursor="pointer"
              onClick={() => toggleSection('breakpoints')}
            >
              <Text fontSize="sm" fontWeight="semibold">
                Breakpoints ({breakpoints.length})
              </Text>
              <FiChevronDown 
                style={{ 
                  transform: expandedSections.breakpoints ? 'rotate(0deg)' : 'rotate(-90deg)',
                  transition: 'transform 0.2s'
                }} 
              />
            </HStack>
            {expandedSections.breakpoints && (
              <Box 
                maxHeight="120px"
                overflowY="auto"
                bg="gray.800"
                borderRadius="md"
                p={2}
              >
                {breakpoints.length === 0 ? (
                  <Text fontSize="sm" color="gray.500">
                    No breakpoints set
                  </Text>
                ) : (
                  breakpoints.map(bp => (
                    <HStack 
                      key={bp.id}
                      justify="space-between"
                      p={2}
                      bg="gray.700"
                      borderRadius="sm"
                      mb={1}
                    >
                      <HStack>
                        <FiCircle 
                          color={bp.verified ? "red" : "gray"} 
                          size={8}
                        />
                        <VStack 
                          align="start" 
                          gap={0}
                        >
                          <Text 
                            fontSize="xs" 
                            fontWeight="semibold"
                          >
                            {bp.file.split('/').pop()}:{bp.line}
                          </Text>
                        </VStack>
                      </HStack>
                      <IconButton
                        aria-label="Remove breakpoint"
                        size="xs"
                        variant="ghost"
                        onClick={() => handleRemoveBreakpoint(bp.id)}
                      >
                        <FiTrash2 />
                      </IconButton>
                    </HStack>
                  ))
                )}
              </Box>
            )}
          </Box>

          {/* Call Stack */}
          <Box>
            <HStack 
              justify="space-between"
              mb={2}
              cursor="pointer"
              onClick={() => toggleSection('callstack')}
            >
              <Text fontSize="sm" fontWeight="semibold">
                Call Stack ({callStack.length})
              </Text>
              <FiChevronDown 
                style={{ 
                  transform: expandedSections.callstack ? 'rotate(0deg)' : 'rotate(-90deg)',
                  transition: 'transform 0.2s'
                }} 
              />
            </HStack>
            {expandedSections.callstack && (
              <Box 
                maxHeight="120px"
                overflowY="auto"
                bg="gray.800"
                borderRadius="md"
                p={2}
              >
                {callStack.length === 0 ? (
                  <Text fontSize="sm" color="gray.500">
                    No stack frames available
                  </Text>
                ) : (
                  callStack.map(frame => (
                    <Box 
                      key={frame.id}
                      p={2}
                      bg="gray.700"
                      borderRadius="sm"
                      mb={1}
                    >
                      <Text fontSize="sm" fontWeight="semibold">
                        {frame.name}
                      </Text>
                      <Text fontSize="xs" color="gray.400">
                        {frame.file.split('/').pop()}:{frame.line}:{frame.column}
                      </Text>
                    </Box>
                  ))
                )}
              </Box>
            )}
          </Box>

          {/* Variables */}
          <Box>
            <HStack 
              justify="space-between"
              mb={2}
              cursor="pointer"
              onClick={() => toggleSection('variables')}
            >
              <Text fontSize="sm" fontWeight="semibold">
                Variables ({variables.length})
              </Text>
              <FiChevronDown 
                style={{ 
                  transform: expandedSections.variables ? 'rotate(0deg)' : 'rotate(-90deg)',
                  transition: 'transform 0.2s'
                }} 
              />
            </HStack>
            {expandedSections.variables && (
              <Box 
                maxHeight="120px"
                overflowY="auto"
                bg="gray.800"
                borderRadius="md"
                p={2}
              >
                {variables.length === 0 ? (
                  <Text fontSize="sm" color="gray.500">
                    No variables available
                  </Text>
                ) : (
                  variables.map((variable, index) => (
                    <HStack 
                      key={index}
                      justify="space-between"
                      p={2}
                      bg="gray.700"
                      borderRadius="sm"
                      mb={1}
                    >
                      <VStack 
                        align="start" 
                        gap={0}
                      >
                        <Text 
                          fontSize="sm" 
                          fontWeight="semibold"
                        >
                          {variable.name}
                        </Text>
                        <Text 
                          fontSize="xs" 
                          color="gray.400"
                        >
                          {variable.type_name}
                        </Text>
                      </VStack>
                      <Text fontSize="sm">
                        {variable.value}
                      </Text>
                    </HStack>
                  ))
                )}
              </Box>
            )}
          </Box>

          {/* Debug Console */}
          <Box flex={1}>
            <HStack 
              justify="space-between" 
              mb={2}
            >
              <HStack 
                cursor="pointer"
                onClick={() => toggleSection('console')}
              >
                <Text fontSize="sm" fontWeight="semibold">
                  Debug Console ({debugConsole.length})
                </Text>
                <FiChevronDown 
                  style={{ 
                    transform: expandedSections.console ? 'rotate(0deg)' : 'rotate(-90deg)',
                    transition: 'transform 0.2s'
                  }} 
                />
              </HStack>
              <IconButton
                aria-label="Clear console"
                size="xs"
                variant="ghost"
                onClick={clearConsole}
              >
                <FiTrash2 />
              </IconButton>
            </HStack>
            {expandedSections.console && (
              <Box
                flex={1}
                minHeight="150px"
                maxHeight="200px"
                bg="black"
                color="green.300"
                p={3}
                borderRadius="md"
                fontSize="xs"
                fontFamily="monospace"
                overflowY="auto"
                border="1px solid"
                borderColor="gray.600"
              >
                {debugConsole.length === 0 ? (
                  <Text color="gray.500">
                    Debug console output will appear here...
                  </Text>
                ) : (
                  debugConsole.map((line, index) => (
                    <Text key={index} mb={1}>
                      {line}
                    </Text>
                  ))
                )}
              </Box>
            )}
          </Box>
        </VStack>
      </VStack>
    </Box>
  )
}

export default DebuggerPanel