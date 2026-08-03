/**
 * headlessHost (P5) — o hospedeiro sem UI responde por política imediata:
 * yolo aprova tudo; sem yolo só o read-only passa; credenciais/perguntas
 * são sempre "cancelado"; nenhum gate humano abre.
 */

import { createHeadlessAgentHost } from '../headlessHost'
import { hasOpenHumanGates } from '../hostBus'

// approveDiff em yolo delega no createDiffApprovalPromise REAL (que aplica o
// diff ao disco via DiffService quando o YOLO da permissionStore está ligado
// — o condutor liga-o). No teste, a store é mockada: o contrato aqui é a
// DELEGAÇÃO, não a aplicação (essa vive nos testes do chatStore).
jest.mock('@/stores/chatStore', () => ({
  createDiffApprovalPromise: jest.fn(async () => true),
}))

describe('createHeadlessAgentHost', () => {
  it('com --yolo aprova escrita, path access e diffs', async () => {
    const host = createHeadlessAgentHost({ yolo: true })
    expect((await host.canUseTool('write_file', {})).approved).toBe(true)
    expect((await host.requestPathAccess('/fora/x', '/fora')).approved).toBe(true)
    expect(await host.approveDiff('tc-1')).toBe(true)
  })

  it('sem --yolo: read-only passa, escrita é negada com razão accionável', async () => {
    const host = createHeadlessAgentHost({ yolo: false })
    expect((await host.canUseTool('read_file', {})).approved).toBe(true)
    expect((await host.canUseTool('Read', {})).approved).toBe(true)
    const denied = await host.canUseTool('write_file', {})
    expect(denied.approved).toBe(false)
    expect(denied.denyReason).toMatch(/--yolo/)
    expect(await host.approveDiff('tc-1')).toBe(false)
    expect((await host.requestPathAccess('/fora/x', '/fora')).approved).toBe(false)
  })

  it('válvula do .env: negada SEMPRE — mesmo com --yolo não há humano', async () => {
    const host = createHeadlessAgentHost({ yolo: true })
    const denied = await host.canUseTool('read_file', { file_path: '/p/.env' }, 'env_file')
    expect(denied.approved).toBe(false)
    expect(denied.denyReason).toMatch(/human approval/)
  })

  it('credenciais e perguntas respondem "cancelado" imediatamente', async () => {
    const host = createHeadlessAgentHost({ yolo: true })
    expect(await host.requestCredentials({
      serviceName: 'X', fields: [], projectRoot: '/p', taskOrigin: null,
    })).toEqual({ submitted: false })
    expect(await host.askUserQuestion({
      questions: [], projectRoot: '/p', taskOrigin: null,
    })).toEqual({})
  })

  it('waitForUserGates resolve já e nenhum gate humano abre', async () => {
    const host = createHeadlessAgentHost({ yolo: true })
    await expect(host.waitForUserGates({ projectId: null, taskId: null })).resolves.toBeUndefined()
    await host.canUseTool('write_file', {})
    await host.approveDiff('tc-2')
    expect(hasOpenHumanGates()).toBe(false)
  })
})
