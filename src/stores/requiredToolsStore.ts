import { create } from 'zustand'
import { invoke } from '@/utils/invokeMetrics'
import { IS_WINDOWS } from '@/utils/platform'

/**
 * Availability of the three MANDATORY external tools (git, Node.js, Python 3).
 *
 * The agent shells out to these constantly (git ops, npm/npx, python scripts),
 * so without them it can't work. Onboarding's ToolsStep already gates the wizard
 * on them, but this store is the RUNTIME safety net: prompt sending is blocked
 * while they're missing (see usePromptBar handleSend).
 *
 * Detection mirrors ToolsStep: `<tool> --version` + output check, NOT
 * `command_exists`, because on Windows `where python` matches the Microsoft
 * Store stub (a fake python.exe) even when Python isn't really installed.
 *
 * FALSE-NEGATIVE HARDENING (root-caused 2026-07-09 — "the IDE suddenly asks
 * to install Git/Python after hours of use"): refresh() runs on every window
 * focus, and the probe used to collapse EVERY failure — 5s timeout while the
 * machine was busy building, a spawn error under fd pressure, an IPC hiccup —
 * into "tool missing", flipping the gate on users with perfectly fine
 * installs. Detection is now tri-state: only a probe that RAN and cleanly
 * said "command not found" (exit 127 / cmd's 9009 / "is not recognized")
 * marks a tool absent; anything inconclusive keeps the last known state.
 */
interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
  /** Set by the Rust side when the command hit the timeout (inconclusive). */
  timedOut?: boolean
}

type ProbeOutcome = 'present' | 'absent' | 'unknown'

interface RequiredToolsState {
  git: boolean
  node: boolean
  python: boolean
  /** True once detection has run at least once this session. */
  checked: boolean
  refresh: () => Promise<void>
}

async function probe(command: string, re: RegExp): Promise<ProbeOutcome> {
  try {
    const r = await invoke<CommandResult>('execute_command', {
      command,
      cwd: IS_WINDOWS ? 'C:\\' : '/tmp',
      timeoutSecs: 5,
    })
    if (r.timedOut) return 'unknown'
    const out = (r.stdout || r.stderr || '').trim()
    if (r.success && r.exitCode === 0) return re.test(out) ? 'present' : 'absent'
    // Clean "not found": POSIX sh exits 127; cmd.exe uses 9009 or prints
    // "is not recognized". The Microsoft Store python stub also lands here
    // (9009), which is exactly what we want.
    if (r.exitCode === 127 || r.exitCode === 9009) return 'absent'
    if (IS_WINDOWS && /is not recognized|não é reconhecid/i.test(r.stderr || '')) return 'absent'
    // The binary EXISTS but misbehaved (broken shim, transient env) — not
    // evidence of absence.
    return 'unknown'
  } catch {
    // invoke rejected: spawn failure (fd pressure), backend busy, IPC error —
    // says nothing about whether the tool is installed.
    return 'unknown'
  }
}

/** present → true; absent → false; unknown → keep what we knew (optimistic
 *  before the first conclusive result, so a hiccup never blocks a valid user). */
function mergeTool(outcome: ProbeOutcome, prev: boolean, checked: boolean): boolean {
  if (outcome === 'present') return true
  if (outcome === 'absent') return false
  return checked ? prev : true
}

/** Python is satisfied by EITHER `python3` or `python` (as long as it's a 3.x).
 *  Absence requires BOTH probes to be conclusive — one inconclusive probe must
 *  not brand Python missing. */
function combinePython(a: ProbeOutcome, b: ProbeOutcome): ProbeOutcome {
  if (a === 'present' || b === 'present') return 'present'
  if (a === 'absent' && b === 'absent') return 'absent'
  return 'unknown'
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
    set((s) => ({
      git: mergeTool(git, s.git, s.checked),
      node: mergeTool(node, s.node, s.checked),
      python: mergeTool(combinePython(py3, py), s.python, s.checked),
      checked: true,
    }))
  },
}))

/**
 * Whether agent prompt sending should be blocked. Optimistic: only blocks once
 * detection has CONFIRMED a tool is missing, so a valid user isn't blocked
 * during the brief first detection (or by an inconclusive probe — see above).
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
