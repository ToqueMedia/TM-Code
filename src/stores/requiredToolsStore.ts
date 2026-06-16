import { create } from 'zustand'
import { invoke } from '@/utils/invokeMetrics'
import { IS_WINDOWS } from '@/utils/platform'

/**
 * Availability of the three MANDATORY external tools (git, Node.js, Python 3).
 *
 * The agent shells out to these constantly (git ops, npm/npx, python scripts),
 * so without them it can't work. Onboarding's ToolsStep already gates the wizard
 * on them, but this store is the RUNTIME safety net: prompt sending is blocked
 * while they're missing (see useCmdPromptLogic / usePromptBar handleSend).
 *
 * Detection mirrors ToolsStep: `<tool> --version` + output check, NOT
 * `command_exists`, because on Windows `where python` matches the Microsoft
 * Store stub (a fake python.exe) even when Python isn't really installed.
 */
interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
}

interface RequiredToolsState {
  git: boolean
  node: boolean
  python: boolean
  /** True once detection has run at least once this session. */
  checked: boolean
  refresh: () => Promise<void>
}

async function probe(command: string, re: RegExp): Promise<boolean> {
  try {
    const r = await invoke<CommandResult>('execute_command', {
      command,
      cwd: IS_WINDOWS ? 'C:\\' : '/tmp',
      timeoutSecs: 5,
    })
    if (!r.success || r.exitCode !== 0) return false
    return re.test((r.stdout || r.stderr || '').trim())
  } catch {
    return false
  }
}

export const useRequiredToolsStore = create<RequiredToolsState>((set) => ({
  git: false,
  node: false,
  python: false,
  checked: false,
  refresh: async () => {
    const [git, node, py3, py] = await Promise.all([
      probe('git --version', /git version/i),
      probe('node --version', /v?\d+\.\d+/i),
      probe('python3 --version', /Python\s+3\./i),
      probe('python --version', /Python\s+3\./i),
    ])
    set({ git, node, python: py3 || py, checked: true })
  },
}))

/**
 * Whether agent prompt sending should be blocked. Optimistic: only blocks once
 * detection has CONFIRMED a tool is missing, so a valid user isn't blocked
 * during the brief first detection.
 */
export function selectAgentBlocked(s: RequiredToolsState): boolean {
  return s.checked && !(s.git && s.node && s.python)
}

/** Names of the tools still missing (for the user-facing hint). */
export function selectMissingTools(s: RequiredToolsState): string[] {
  if (!s.checked) return []
  const missing: string[] = []
  if (!s.git) missing.push('Git')
  if (!s.node) missing.push('Node.js')
  if (!s.python) missing.push('Python 3')
  return missing
}
