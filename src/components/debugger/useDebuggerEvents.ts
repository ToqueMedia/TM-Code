import { useEffect } from 'react'

import DebuggerService, { DebuggerEvent } from '../../services/debuggerService'

interface UseDebuggerEventsParams {
  debuggerService: DebuggerService
  addConsoleMessage: (message: string) => void
  refreshSessions: () => Promise<void>
  refreshDebugInfo: () => Promise<void>
  setIsDebugging: (value: boolean) => void
}

/**
 * Subscribes to DebuggerService events and dispatches
 * the appropriate state updates / console messages.
 */
export function useDebuggerEvents({
  debuggerService,
  addConsoleMessage,
  refreshSessions,
  refreshDebugInfo,
  setIsDebugging
}: UseDebuggerEventsParams) {
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
}

interface UseDebuggerShortcutsParams {
  activeSession: string | null
  isDebugging: boolean
  addConsoleMessage: (message: string) => void
  handleDebugAction: (action: string) => Promise<void>
  handleStopDebug: () => Promise<void>
  setShowConfig: (value: boolean) => void
}

/**
 * Registers window-level keyboard shortcut event listeners
 * for debugger actions (F5 start/continue, F9 breakpoint, F10/F11 step).
 */
export function useDebuggerShortcuts({
  activeSession,
  isDebugging,
  addConsoleMessage,
  handleDebugAction,
  handleStopDebug,
  setShowConfig
}: UseDebuggerShortcutsParams) {
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
}
