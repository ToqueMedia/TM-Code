import { DebugBreakpoint, DebugStackFrame, DebugVariable } from '../../services/debuggerService'

export interface DebugConfigForm {
  name: string
  program: string
  args: string
  cwd: string
  debugType: string
}

export interface DebuggerControlsProps {
  activeSession: string | null
  isDebugging: boolean
  loading: boolean
  onShowConfig: () => void
  onDebugAction: (action: string) => void
  onStopDebug: () => void
}

export interface DebuggerConfigProps {
  configForm: DebugConfigForm
  availableDebuggers: Record<string, string>
  loading: boolean
  onConfigChange: (form: DebugConfigForm) => void
  onStart: () => void
  onCancel: () => void
}

export interface BreakpointsSectionProps {
  breakpoints: DebugBreakpoint[]
  expanded: boolean
  onToggle: () => void
  onRemoveBreakpoint: (id: string) => void
}

export interface CallStackSectionProps {
  callStack: DebugStackFrame[]
  expanded: boolean
  onToggle: () => void
}

export interface VariablesSectionProps {
  variables: DebugVariable[]
  expanded: boolean
  onToggle: () => void
}

export interface DebugConsoleProps {
  debugConsole: string[]
  expanded: boolean
  onToggle: () => void
  onClear: () => void
}
