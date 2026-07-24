import { useState, useEffect, useCallback } from 'react'

import DebuggerService, {
  DebugSession,
  DebugBreakpoint,
  DebugStackFrame,
  DebugVariable
} from '../../services/debuggerService'
import { logger } from '../../utils/logger'

import type { DebugConfigForm } from './types'
import { useDebuggerActions } from './useDebuggerActions'
import { useDebuggerEvents, useDebuggerShortcuts } from './useDebuggerEvents'
import { stripAnsi } from '@/utils/stripAnsi'

export function useDebugger() {
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
    // Strip ANSI so DAP/adapter noise like [38;5;246m never paints raw.
    setDebugConsole(prev => [...prev, `[${timestamp}] ${stripAnsi(message)}`])
  }, [])

  const refreshSessions = useCallback(async () => {
    try {
      const allSessions = await debuggerService.getDebugSessions()
      setSessions(allSessions)
    } catch (error) {
      logger.error('debugger', 'Failed to refresh sessions:', error)
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

      if (callStackData.length > 0) {
        const vars = await debuggerService.getVariables(activeSession, callStackData[0].id)
        setVariables(vars)
      }
    } catch (error) {
      logger.error('debugger', 'Failed to refresh debug info:', error)
    }
  }, [activeSession, debuggerService])

  // Load available debuggers on mount
  useEffect(() => {
    async function loadDebuggers() {
      try {
        const debuggers = await debuggerService.checkDebuggerAvailability()
        setAvailableDebuggers(debuggers)
      } catch (error) {
        logger.error('debugger', 'Failed to load debuggers:', error)
        addConsoleMessage('Failed to load available debuggers')
      }
    }

    loadDebuggers()
  }, [debuggerService, addConsoleMessage])

  // Debugger service event listeners
  useDebuggerEvents({
    debuggerService,
    addConsoleMessage,
    refreshSessions,
    refreshDebugInfo,
    setIsDebugging
  })

  // Debug action handlers
  const {
    handleStartDebug,
    handleStopDebug,
    handleDebugAction,
    handleRemoveBreakpoint
  } = useDebuggerActions({
    debuggerService,
    activeSession,
    configForm,
    addConsoleMessage,
    refreshDebugInfo,
    setActiveSession,
    setIsDebugging,
    setShowConfig,
    setLoading,
    setBreakpoints: setBreakpoints as (value: []) => void,
    setCallStack: setCallStack as (value: []) => void,
    setVariables: setVariables as (value: []) => void
  })

  // Keyboard shortcut listeners
  useDebuggerShortcuts({
    activeSession,
    isDebugging,
    addConsoleMessage,
    handleDebugAction,
    handleStopDebug,
    setShowConfig
  })

  const clearConsole = useCallback(() => {
    setDebugConsole([])
  }, [])

  const toggleSection = useCallback((section: string) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }))
  }, [])

  return {
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
  }
}
