/**
 * Multi-writer item board mirror (disk merge by session).
 */

import { mirrorTaskBoard, readTaskBoard } from '../taskBoardService'

const mockInvoke = jest.fn()

jest.mock('@/utils/invokeMetrics', () => ({
  invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}))

jest.mock('@/services/projectStatePaths', () => ({
  getProjectStateDir: async () => '/state/proj',
}))

jest.mock('@/utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

describe('taskBoardService', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it('writes open items for a session', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file') throw new Error('missing')
      if (cmd === 'write_file') return undefined
      return null
    })

    await mirrorTaskBoard('/proj', 'sess-a', [
      { id: '1.1', description: 'Scaffold', status: 'in_progress', claimedBy: 'main', claimedAt: 1 },
      { id: '1.2', description: 'Done', status: 'completed' },
    ])

    const writeCall = mockInvoke.mock.calls.find((c) => c[0] === 'write_file')
    expect(writeCall).toBeTruthy()
    const payload = JSON.parse(writeCall![1].content)
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).toMatchObject({
      id: '1.1',
      claimedBy: 'main',
      sessionId: 'sess-a',
    })
  })

  it('merges other sessions instead of clobbering', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file') {
        return JSON.stringify({
          updatedAt: 1,
          pid: 0,
          items: [
            { id: 'x', description: 'Other', status: 'pending', sessionId: 'sess-b' },
          ],
        })
      }
      return undefined
    })

    await mirrorTaskBoard('/proj', 'sess-a', [
      { id: '1.1', description: 'Mine', status: 'pending' },
    ])

    const writeCall = mockInvoke.mock.calls.find((c) => c[0] === 'write_file')
    const payload = JSON.parse(writeCall![1].content)
    expect(payload.items.map((i: { id: string }) => i.id).sort()).toEqual(['1.1', 'x'])
  })

  it('readTaskBoard returns null on missing file', async () => {
    mockInvoke.mockRejectedValue(new Error('enoent'))
    expect(await readTaskBoard('/proj')).toBeNull()
  })
})
