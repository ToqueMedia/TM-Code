import 'openai/shims/node'

// Núcleo partilhado da construção do cliente de run (FUSÃO F3). Mocka as três
// dependências externas (SDK managed, cliente BYOK, auth) e verifica os dois
// ramos + a dança de refresh do token.

const managedClients: unknown[] = []
const subAgentClients: unknown[] = []
const byokCalls: Array<{ lightweight: boolean }> = []
let byokReturns: unknown = { __byok: true }

jest.mock('../sdkClient', () => ({
  createAgentClient: jest.fn((token: string) => {
    const c = { __managed: true, token }
    managedClients.push(c)
    return c
  }),
  createSubAgentClient: jest.fn((token: string) => {
    const c = { __sub: true, token }
    subAgentClients.push(c)
    return c
  }),
}))

jest.mock('../byokRouting', () => ({
  buildByokClientFromSnapshot: jest.fn(
    async (_snapshot: unknown, opts: { lightweight: boolean; onKeyMissing?: () => void }) => {
      byokCalls.push({ lightweight: opts.lightweight })
      if (byokReturns === null) opts.onKeyMissing?.()
      return byokReturns
    },
  ),
}))

const getIdToken = jest.fn()
const refreshLogin = jest.fn()
jest.mock('../../auth/firebaseAuth', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getIdToken, refreshLogin }) },
}))

import { buildRunClient } from '../runClient'
import type { ByokSessionSnapshot } from '../../../types/chat'

const snapshot = { providerId: 'openai', modelId: 'gpt-x' } as unknown as ByokSessionSnapshot

beforeEach(() => {
  managedClients.length = 0
  subAgentClients.length = 0
  byokCalls.length = 0
  byokReturns = { __byok: true }
  getIdToken.mockReset()
  refreshLogin.mockReset()
})

describe('buildRunClient (núcleo partilhado F3)', () => {
  it('rota gerida: usa createAgentClient com o token', async () => {
    const rc = await buildRunClient({ authToken: 'tok', snapshot: null, byokActive: false, lightweight: false })
    expect(rc).not.toBeNull()
    expect(rc!.client).toMatchObject({ __managed: true, token: 'tok' })
    expect(byokCalls).toHaveLength(0)
  })

  it('lightweight: usa createSubAgentClient', async () => {
    const rc = await buildRunClient({ authToken: 'tok', snapshot: null, byokActive: false, lightweight: true })
    expect(rc!.client).toMatchObject({ __sub: true })
  })

  it('BYOK ativo + snapshot: usa o cliente BYOK (não o gerido)', async () => {
    const rc = await buildRunClient({ authToken: 'tok', snapshot, byokActive: true, lightweight: false })
    expect(rc!.client).toMatchObject({ __byok: true })
    expect(byokCalls).toEqual([{ lightweight: false }])
    expect(managedClients).toHaveLength(0)
  })

  it('BYOK sem key: devolve null e chama onByokKeyMissing', async () => {
    byokReturns = null
    const onByokKeyMissing = jest.fn()
    const rc = await buildRunClient({ authToken: 'tok', snapshot, byokActive: true, lightweight: false, onByokKeyMissing })
    expect(rc).toBeNull()
    expect(onByokKeyMissing).toHaveBeenCalledTimes(1)
  })

  it('byokActive mas snapshot null: cai na rota gerida', async () => {
    const rc = await buildRunClient({ authToken: 'tok', snapshot: null, byokActive: true, lightweight: false })
    expect(rc!.client).toMatchObject({ __managed: true })
    expect(byokCalls).toHaveLength(0)
  })

  it('refresh gerido: getIdToken(true) → novo cliente', async () => {
    getIdToken.mockResolvedValueOnce('fresh')
    const rc = await buildRunClient({ authToken: 'tok', snapshot: null, byokActive: false, lightweight: false })
    const refreshed = await rc!.refreshClient()
    expect(refreshed).toMatchObject({ __managed: true, token: 'fresh' })
    expect(refreshLogin).not.toHaveBeenCalled()
  })

  it('refresh gerido: token null → tenta refreshLogin → getIdToken de novo', async () => {
    getIdToken.mockResolvedValueOnce(null).mockResolvedValueOnce('after-relogin')
    refreshLogin.mockResolvedValueOnce(true)
    const rc = await buildRunClient({ authToken: 'tok', snapshot: null, byokActive: false, lightweight: false })
    const refreshed = await rc!.refreshClient()
    expect(refreshLogin).toHaveBeenCalledTimes(1)
    expect(refreshed).toMatchObject({ token: 'after-relogin' })
  })

  it('refresh gerido: relogin falha → null (loop trata como auth error)', async () => {
    getIdToken.mockResolvedValueOnce(null)
    refreshLogin.mockResolvedValueOnce(false)
    const rc = await buildRunClient({ authToken: 'tok', snapshot: null, byokActive: false, lightweight: false })
    expect(await rc!.refreshClient()).toBeNull()
  })

  it('refresh BYOK: reconstrói do snapshot (sem tocar no auth)', async () => {
    const rc = await buildRunClient({ authToken: 'tok', snapshot, byokActive: true, lightweight: false })
    byokCalls.length = 0
    const refreshed = await rc!.refreshClient()
    expect(refreshed).toMatchObject({ __byok: true })
    expect(byokCalls).toEqual([{ lightweight: false }])
    expect(getIdToken).not.toHaveBeenCalled()
  })
})
