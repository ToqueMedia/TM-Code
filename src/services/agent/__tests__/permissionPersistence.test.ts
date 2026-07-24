/**
 * Round-trip do permissions.json — o formato em disco é um contrato durável
 * (grants de confiança por projeto). Bloqueia regressões no novo campo
 * `approvedCommandPrefixes` (Gap 1 passo B) e confirma a compat com ficheiros
 * v2 antigos que não o têm.
 */

const invokeMock = jest.fn()
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

import { loadPermissionsFromDisk, savePermissionsToDisk } from '../permissionPersistence'

describe('permissionPersistence — round-trip de approvedCommandPrefixes', () => {
  beforeEach(() => invokeMock.mockReset())

  it('grava e relê os prefixos de comando', async () => {
    let written = ''
    invokeMock.mockImplementation((cmd: string, args: { content?: string }) => {
      if (cmd === 'write_agent_state') { written = args.content ?? ''; return Promise.resolve() }
      if (cmd === 'read_agent_state') return Promise.resolve(written)
      return Promise.resolve(null)
    })

    await savePermissionsToDisk(
      '/proj',
      new Set(['core']),
      new Set(['read_file']),
      new Set(['/proj/extra']),
      true,
      new Set(['gcloud secrets versions add', 'npm run']),
    )

    const payload = JSON.parse(written)
    expect(payload.schemaVersion).toBe(2)
    expect(payload.approvedCommandPrefixes).toEqual(['gcloud secrets versions add', 'npm run'])

    const loaded = await loadPermissionsFromDisk('/proj')
    expect(Array.from(loaded.commandPrefixes)).toEqual(['gcloud secrets versions add', 'npm run'])
    expect(loaded.autoMode).toBe(true)
  })

  it('ficheiro v2 sem o campo carrega commandPrefixes vazio (compat)', async () => {
    const legacy = JSON.stringify({
      schemaVersion: 2,
      updatedAt: '2026-07-20T00:00:00.000Z',
      approvedScopes: ['core'],
      approvedTools: ['execute_command'],
    })
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'read_agent_state' ? legacy : null),
    )

    const loaded = await loadPermissionsFromDisk('/proj')
    expect(loaded.commandPrefixes.size).toBe(0)
    expect(loaded.tools.has('execute_command')).toBe(true)
  })
})
