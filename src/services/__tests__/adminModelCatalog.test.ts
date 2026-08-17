jest.mock('../auth/firebaseAuth', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getIdToken: jest.fn().mockResolvedValue('test-token'),
    }),
  },
}))

const tauriFetch = jest.fn()
jest.mock('../tauriFetch', () => ({
  tauriFetch: (...args: unknown[]) => tauriFetch(...args),
}))

import {
  createModel,
  createSidecarModel,
  deleteModel,
  deleteSidecarModel,
  fetchModelCatalog,
  fetchSidecarCatalog,
  updateModel,
  updateSidecarModel,
  type AdminModelInput,
  type SidecarModelInput,
} from '../adminService'

const CODER: AdminModelInput = {
  id: 'probe',
  name: 'Probe',
  providerLabel: 'Alibaba US',
  activeConfig: {
    provider: 'dashscope',
    model: 'probe',
    baseUrl: 'https://example.com/v1',
    chatCompletionsPath: '/chat/completions',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    enabled: true,
    contextWindow: 200_000,
  },
}

const SIDECAR: SidecarModelInput = {
  ...CODER,
  id: 'probe-sidecar',
  roles: ['utility'],
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

beforeEach(() => {
  tauriFetch.mockReset()
})

describe('admin model catalog client', () => {
  it('GETs the coder catalog and returns models', async () => {
    tauriFetch.mockResolvedValueOnce(jsonResponse(200, { models: [{ ...CODER, category: 'coder' }] }))
    const models = await fetchModelCatalog()
    expect(models).toHaveLength(1)
    expect(tauriFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/admin\/models$/),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    )
  })

  it('POSTs a coder entry and PUTs an update', async () => {
    tauriFetch.mockResolvedValueOnce(jsonResponse(200, { model: { ...CODER, category: 'coder' } }))
    await createModel(CODER)
    expect(tauriFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/admin\/models$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(CODER),
      }),
    )

    tauriFetch.mockResolvedValueOnce(jsonResponse(200, { model: { ...CODER, name: 'Probe 2', category: 'coder' } }))
    const updated = await updateModel('probe', { ...CODER, name: 'Probe 2' })
    expect(updated.name).toBe('Probe 2')
    expect(tauriFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/admin\/models\/probe$/),
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('DELETEs a coder model', async () => {
    tauriFetch.mockResolvedValueOnce(jsonResponse(200, { deleted: 'probe' }))
    await deleteModel('probe')
    expect(tauriFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/admin\/models\/probe$/),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('maps 403 to FORBIDDEN and surfaces a 409 with the referenced slots', async () => {
    tauriFetch.mockResolvedValueOnce(jsonResponse(403, { error: 'nope' }))
    await expect(fetchModelCatalog()).rejects.toThrow('FORBIDDEN')

    tauriFetch.mockResolvedValueOnce(jsonResponse(409, {
      error: 'Model probe is in use by: persona:expert, active. Reassign or disable those slots first.',
    }))
    await expect(deleteModel('probe')).rejects.toThrow(/persona:expert/)
  })

  it('covers the sidecar catalog URLs', async () => {
    tauriFetch.mockResolvedValueOnce(jsonResponse(200, { models: [] }))
    await fetchSidecarCatalog()
    expect(tauriFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/admin\/sidecar-models$/),
      expect.objectContaining({ method: 'GET' }),
    )

    tauriFetch.mockResolvedValueOnce(jsonResponse(200, { model: { ...SIDECAR } }))
    await createSidecarModel(SIDECAR)
    const lastCall = tauriFetch.mock.calls[tauriFetch.mock.calls.length - 1] as [string, { method: string; body: string }]
    expect(lastCall[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(SIDECAR),
    }))

    tauriFetch.mockResolvedValueOnce(jsonResponse(200, { model: { ...SIDECAR, name: 'Updated' } }))
    await updateSidecarModel('probe-sidecar', SIDECAR)
    expect(tauriFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/admin\/sidecar-models\/probe-sidecar$/),
      expect.objectContaining({ method: 'PUT' }),
    )

    tauriFetch.mockResolvedValueOnce(jsonResponse(200, { deleted: 'probe-sidecar' }))
    await deleteSidecarModel('probe-sidecar')
    expect(tauriFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/admin\/sidecar-models\/probe-sidecar$/),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
