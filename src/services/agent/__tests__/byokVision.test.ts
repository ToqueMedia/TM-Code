import { resolveByokNativeVision } from '../byokVision'

jest.mock('../../../stores/byokStore', () => ({
  useByokStore: {
    getState: () => ({
      providers: [
        {
          id: 'p1',
          models: [{ id: 'vision-model', capabilities: { images: true } }],
        },
      ],
      perProviderConfig: {},
    }),
  },
}))

describe('resolveByokNativeVision', () => {
  it('returns null when not on BYOK', () => {
    expect(resolveByokNativeVision(null)).toBeNull()
  })

  it('uses snapshot.capabilities.images when present', () => {
    expect(
      resolveByokNativeVision({
        providerId: 'p1',
        modelId: 'x',
        capabilities: { images: false },
      } as never),
    ).toBe(false)
  })

  it('falls back to registry model capabilities', () => {
    expect(
      resolveByokNativeVision({
        providerId: 'p1',
        modelId: 'vision-model',
      } as never),
    ).toBe(true)
  })
})
