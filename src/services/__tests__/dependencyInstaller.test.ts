import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  ensureDependenciesInstalled,
  runStreamingInstall,
} from '../dependencyInstaller'

// `@tauri-apps/api/core` invoke is auto-mocked in setupTests; the event module
// is not, so mock `listen` here and drive its handlers by hand.
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn() }))

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>
const mockedListen = listen as jest.MockedFunction<typeof listen>

const PROJECT = '/test/project'

type Handler = (e: { payload: unknown }) => void
let handlers: Record<string, Handler>

beforeEach(() => {
  jest.clearAllMocks()
  handlers = {}
  mockedListen.mockImplementation((async (event: string, cb: Handler) => {
    handlers[event] = cb
    return (() => {}) as unknown
  }) as unknown as typeof listen)
})

/**
 * Wire the invoke mock:
 *  - path_exists → true for any path in `present`
 *  - run_streaming_command → returns `runPid`, then (on a macrotask, after the
 *    caller has the pid) emits each `outputs` chunk and finally cmd-exit/`exitCode`.
 */
function setupInvoke(opts: {
  present?: string[]
  runPid?: number
  exitCode?: number
  outputs?: string[]
}) {
  const present = new Set(opts.present ?? [])
  const pid = opts.runPid ?? 4242
  const exitCode = opts.exitCode ?? 0
  const outputs = opts.outputs ?? []

  mockedInvoke.mockImplementation((async (cmd: string, args?: { path?: string }) => {
    if (cmd === 'path_exists') return present.has(args?.path ?? '')
    if (cmd === 'run_streaming_command') {
      setTimeout(() => {
        for (const data of outputs) {
          handlers['cmd-output']?.({ payload: { pid, stream: 'stdout', data } })
        }
        handlers['cmd-exit']?.({ payload: { pid, code: exitCode } })
      }, 0)
      return pid
    }
    return undefined
  }) as unknown as typeof invoke)
}

function invokedCommands(): string[] {
  return mockedInvoke.mock.calls.map(c => c[0] as string)
}

describe('ensureDependenciesInstalled', () => {
  it('is a no-op when node_modules already exists', async () => {
    setupInvoke({ present: [`${PROJECT}/node_modules`] })
    const onInstallStart = jest.fn()

    const res = await ensureDependenciesInstalled(PROJECT, { onInstallStart })

    expect(res).toEqual({ status: 'present' })
    expect(onInstallStart).not.toHaveBeenCalled()
    expect(invokedCommands()).not.toContain('run_streaming_command')
  })

  it('skips when there is no package.json', async () => {
    setupInvoke({ present: [] }) // neither node_modules nor package.json

    const res = await ensureDependenciesInstalled(PROJECT)

    expect(res).toEqual({ status: 'skipped' })
    expect(invokedCommands()).not.toContain('run_streaming_command')
  })

  it('installs with the lockfile package manager and streams output', async () => {
    setupInvoke({
      // node_modules missing; yarn.lock present → yarn install
      present: [`${PROJECT}/package.json`, `${PROJECT}/yarn.lock`],
      outputs: ['Resolving packages...\n', 'Done\n'],
      exitCode: 0,
    })
    const onInstallStart = jest.fn()
    const logs: Array<[string, string]> = []

    const res = await ensureDependenciesInstalled(PROJECT, {
      onInstallStart,
      onLog: (text, level) => logs.push([text, level]),
    })

    expect(res).toEqual({ status: 'installed' })
    expect(onInstallStart).toHaveBeenCalledWith('yarn install')
    const runCall = mockedInvoke.mock.calls.find(c => c[0] === 'run_streaming_command')
    expect(runCall?.[1]).toEqual({ command: 'yarn install', cwd: PROJECT })
    expect(logs.some(([text]) => text.includes('Resolving packages'))).toBe(true)
  })

  it('reports failure when the install exits non-zero', async () => {
    setupInvoke({
      present: [`${PROJECT}/package.json`, `${PROJECT}/package-lock.json`],
      exitCode: 1,
    })
    const logs: Array<[string, string]> = []

    const res = await ensureDependenciesInstalled(PROJECT, {
      onLog: (text, level) => logs.push([text, level]),
    })

    expect(res.status).toBe('failed')
    expect(logs.some(([, level]) => level === 'error')).toBe(true)
  })
})

describe('runStreamingInstall', () => {
  it('resolves ok and forwards output on a clean exit', async () => {
    setupInvoke({ runPid: 99, outputs: ['line1\n'], exitCode: 0 })
    const out: string[] = []

    const res = await runStreamingInstall(PROJECT, 'npm install', {
      onOutput: text => out.push(text),
    })

    expect(res).toEqual({ ok: true })
    expect(out).toContain('line1\n')
  })

  it('surfaces a non-zero exit code', async () => {
    setupInvoke({ runPid: 7, exitCode: 2 })

    const res = await runStreamingInstall(PROJECT, 'npm install')

    expect(res).toEqual({ ok: false, reason: 'exit', exitCode: 2 })
  })
})
