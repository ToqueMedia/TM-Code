import { useCallback } from 'react'

import DebuggerService, { DebugConfiguration } from '../../services/debuggerService'
import { logger } from '../../utils/logger'

import type { DebugConfigForm } from './types'

interface UseDebuggerActionsParams {
  debuggerService: DebuggerService
  activeSession: string | null
  configForm: DebugConfigForm
  addConsoleMessage: (message: string) => void
  refreshDebugInfo: () => Promise<void>
  setActiveSession: (id: string | null) => void
  setIsDebugging: (value: boolean) => void
  setShowConfig: (value: boolean) => void
  setLoading: (value: boolean) => void
  setBreakpoints: (value: []) => void
  setCallStack: (value: []) => void
  setVariables: (value: []) => void
}

export function useDebuggerActions({
  debuggerService,
  activeSession,
  configForm,
  addConsoleMessage,
  refreshDebugInfo,
  setActiveSession,
  setIsDebugging,
  setShowConfig,
  setLoading,
  setBreakpoints,
  setCallStack,
  setVariables
}: UseDebuggerActionsParams) {
  const handleStartDebug = useCallback(async () => {
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

      await debuggerService.launchDebugSession(sessionId)
      setIsDebugging(true)

      addConsoleMessage(`Started debugging: ${config.name}`)

      await refreshDebugInfo()
    } catch (error) {
      logger.error('debugger', 'Failed to start debugging:', error)
      addConsoleMessage(`Debug Error: Failed to start debugging: ${error}`)
    } finally {
      setLoading(false)
    }
  }, [configForm, debuggerService, addConsoleMessage, refreshDebugInfo, setActiveSession, setIsDebugging, setShowConfig, setLoading])

  const handleStopDebug = useCallback(async () => {
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
      logger.error('debugger', 'Failed to stop debugging:', error)
      addConsoleMessage(`Error: Failed to stop debugging: ${error}`)
    } finally {
      setLoading(false)
    }
  }, [activeSession, debuggerService, addConsoleMessage, setActiveSession, setIsDebugging, setLoading, setBreakpoints, setCallStack, setVariables])

  const handleDebugAction = useCallback(async (action: string) => {
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
      logger.error('debugger', `Failed to ${action}:`, error)
      addConsoleMessage(`Debug Error: Failed to ${action}: ${error}`)
    } finally {
      setLoading(false)
    }
  }, [activeSession, debuggerService, addConsoleMessage, setIsDebugging, setLoading])

  const handleRemoveBreakpoint = useCallback(async (breakpointId: string) => {
    if (!activeSession) return

    try {
      await debuggerService.removeBreakpoint(activeSession, breakpointId)
      await refreshDebugInfo()
      addConsoleMessage(`Breakpoint removed: ${breakpointId}`)
    } catch (error) {
      logger.error('debugger', 'Failed to remove breakpoint:', error)
    }
  }, [activeSession, debuggerService, addConsoleMessage, refreshDebugInfo])

  return {
    handleStartDebug,
    handleStopDebug,
    handleDebugAction,
    handleRemoveBreakpoint
  }
}
