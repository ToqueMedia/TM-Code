import { invoke } from '@/utils/invokeMetrics'
import { logger } from '../utils/logger'

// TypeScript interfaces matching the Rust types
export interface DebugBreakpoint {
  id: string
  file: string
  line: number
  verified: boolean
  message?: string
}

export interface DebugStackFrame {
  id: number
  name: string
  file: string
  line: number
  column: number
}

export interface DebugVariable {
  name: string
  value: string
  type_name: string
  has_children: boolean
  variables_reference: number
}

export interface DebugSession {
  id: string
  name: string
  status: DebugStatus
  breakpoints: DebugBreakpoint[]
  current_frame?: DebugStackFrame
}

export type DebugStatus = 'Stopped' | 'Running' | 'Paused' | 'Terminated'

export interface DebugConfiguration {
  name: string
  program: string
  args: string[]
  cwd: string
  env: Record<string, string>
  debug_type: string // 'node', 'python', etc.
}

// Event types for debugger state changes
export type DebuggerEventType = 
  | 'session-started'
  | 'session-stopped' 
  | 'breakpoint-hit'
  | 'execution-paused'
  | 'execution-continued'
  | 'step-completed'

export interface DebuggerEvent {
  type: DebuggerEventType
  session_id: string
  data?: Record<string, unknown>
}

export type DebuggerEventCallback = (event: DebuggerEvent) => void

class DebuggerService {
  private static instance: DebuggerService
  private eventCallbacks: DebuggerEventCallback[] = []
  private activeSessions: Map<string, DebugSession> = new Map()

  private constructor() {}

  static getInstance(): DebuggerService {
    if (!DebuggerService.instance) {
      DebuggerService.instance = new DebuggerService()
    }
    return DebuggerService.instance
  }

  // Event management
  addEventListener(callback: DebuggerEventCallback): void {
    this.eventCallbacks.push(callback)
  }

  removeEventListener(callback: DebuggerEventCallback): void {
    const index = this.eventCallbacks.indexOf(callback)
    if (index > -1) {
      this.eventCallbacks.splice(index, 1)
    }
  }

  dispose(): void {
    this.eventCallbacks = []
    this.activeSessions.clear()
  }

  private emitEvent(event: DebuggerEvent): void {
    this.eventCallbacks.forEach(callback => callback(event))
  }

  // Debugger availability
  async checkDebuggerAvailability(): Promise<Record<string, string>> {
    try {
      return await invoke<Record<string, string>>('check_debugger_availability')
    } catch (error) {
      logger.error('debugger', 'Failed to check debugger availability:', error)
      throw error
    }
  }

  // Session management
  async startDebugSession(config: DebugConfiguration): Promise<string> {
    try {
      const sessionId = await invoke<string>('start_debug_session', { config })
      
      this.emitEvent({
        type: 'session-started',
        session_id: sessionId,
        data: config as unknown as Record<string, unknown>
      })

      return sessionId
    } catch (error) {
      logger.error('debugger', 'Failed to start debug session:', error)
      throw error
    }
  }

  async stopDebugSession(sessionId: string): Promise<void> {
    try {
      await invoke<void>('stop_debug_session', { sessionId })
      
      this.activeSessions.delete(sessionId)
      
      this.emitEvent({
        type: 'session-stopped',
        session_id: sessionId
      })
    } catch (error) {
      logger.error('debugger', 'Failed to stop debug session:', error)
      throw error
    }
  }

  async launchDebugSession(sessionId: string): Promise<void> {
    try {
      await invoke<void>('launch_debug_session', { sessionId })
      
      this.emitEvent({
        type: 'execution-continued',
        session_id: sessionId
      })
    } catch (error) {
      logger.error('debugger', 'Failed to launch debug session:', error)
      throw error
    }
  }

  async getDebugSessions(): Promise<DebugSession[]> {
    try {
      const sessions = await invoke<DebugSession[]>('get_debug_sessions')
      
      // Update local session cache
      this.activeSessions.clear()
      sessions.forEach(session => {
        this.activeSessions.set(session.id, session)
      })
      
      return sessions
    } catch (error) {
      logger.error('debugger', 'Failed to get debug sessions:', error)
      throw error
    }
  }

  // Breakpoint management
  async setBreakpoint(sessionId: string, file: string, line: number): Promise<DebugBreakpoint> {
    try {
      const breakpoint = await invoke<DebugBreakpoint>('set_breakpoint', {
        sessionId,
        file,
        line
      })
      
      return breakpoint
    } catch (error) {
      logger.error('debugger', 'Failed to set breakpoint:', error)
      throw error
    }
  }

  async removeBreakpoint(sessionId: string, breakpointId: string): Promise<void> {
    try {
      await invoke<void>('remove_breakpoint', {
        sessionId,
        breakpointId
      })
    } catch (error) {
      logger.error('debugger', 'Failed to remove breakpoint:', error)
      throw error
    }
  }

  async getBreakpoints(sessionId: string): Promise<DebugBreakpoint[]> {
    try {
      return await invoke<DebugBreakpoint[]>('get_breakpoints', { sessionId })
    } catch (error) {
      logger.error('debugger', 'Failed to get breakpoints:', error)
      throw error
    }
  }

  // Debug execution control
  async debugContinue(sessionId: string): Promise<void> {
    try {
      await invoke<void>('debug_continue', { sessionId })
      
      this.emitEvent({
        type: 'execution-continued',
        session_id: sessionId
      })
    } catch (error) {
      logger.error('debugger', 'Failed to continue debugging:', error)
      throw error
    }
  }

  async debugPause(sessionId: string): Promise<void> {
    try {
      await invoke<void>('debug_pause', { sessionId })
      
      this.emitEvent({
        type: 'execution-paused',
        session_id: sessionId
      })
    } catch (error) {
      logger.error('debugger', 'Failed to pause debugging:', error)
      throw error
    }
  }

  async debugStepOver(sessionId: string): Promise<void> {
    try {
      await invoke<void>('debug_step_over', { sessionId })
      
      this.emitEvent({
        type: 'step-completed',
        session_id: sessionId,
        data: { type: 'step-over' }
      })
    } catch (error) {
      logger.error('debugger', 'Failed to step over:', error)
      throw error
    }
  }

  async debugStepInto(sessionId: string): Promise<void> {
    try {
      await invoke<void>('debug_step_into', { sessionId })
      
      this.emitEvent({
        type: 'step-completed',
        session_id: sessionId,
        data: { type: 'step-into' }
      })
    } catch (error) {
      logger.error('debugger', 'Failed to step into:', error)
      throw error
    }
  }

  async debugStepOut(sessionId: string): Promise<void> {
    try {
      await invoke<void>('debug_step_out', { sessionId })
      
      this.emitEvent({
        type: 'step-completed',
        session_id: sessionId,
        data: { type: 'step-out' }
      })
    } catch (error) {
      logger.error('debugger', 'Failed to step out:', error)
      throw error
    }
  }

  // Debug information
  async getCallStack(sessionId: string): Promise<DebugStackFrame[]> {
    try {
      return await invoke<DebugStackFrame[]>('get_call_stack', { sessionId })
    } catch (error) {
      logger.error('debugger', 'Failed to get call stack:', error)
      throw error
    }
  }

  async getVariables(sessionId: string, frameId: number): Promise<DebugVariable[]> {
    try {
      return await invoke<DebugVariable[]>('get_variables', {
        sessionId,
        frameId
      })
    } catch (error) {
      logger.error('debugger', 'Failed to get variables:', error)
      throw error
    }
  }

  // Utility methods
  getActiveSession(sessionId: string): DebugSession | undefined {
    return this.activeSessions.get(sessionId)
  }

  getAllActiveSessions(): DebugSession[] {
    return Array.from(this.activeSessions.values())
  }

  // Create debug configuration for common scenarios
  createNodeJSConfig(options: {
    name: string
    program: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
  }): DebugConfiguration {
    return {
      name: options.name,
      program: options.program,
      args: options.args || [],
      cwd: options.cwd || '',
      env: options.env || {},
      debug_type: 'node'
    }
  }

  // Helper to toggle breakpoint at a specific location
  async toggleBreakpoint(sessionId: string, file: string, line: number): Promise<DebugBreakpoint | null> {
    try {
      const existingBreakpoints = await this.getBreakpoints(sessionId)
      const existing = existingBreakpoints.find(bp => bp.file === file && bp.line === line)
      
      if (existing) {
        await this.removeBreakpoint(sessionId, existing.id)
        return null // Breakpoint removed
      } else {
        return await this.setBreakpoint(sessionId, file, line)
      }
    } catch (error) {
      logger.error('debugger', 'Failed to toggle breakpoint:', error)
      throw error
    }
  }
}

export default DebuggerService