/**
 * O sidecar de visão NÃO pode deitar fora um 200 só porque o texto veio em
 * `reasoning_content` ou num array de partes — era isso que fazia o modelo
 * principal receber o XML "image did not reach you" com o sidecar a ter
 * descrito a imagem (pasted-image.png, 2026-08-14).
 */
jest.mock('../../../utils/devUrls', () => ({
  resolveAIWorkerUrl: () => 'https://worker.test',
}))
jest.mock('../byokRouting', () => ({ resolveAuxByokRoute: jest.fn(() => null) }))
jest.mock('../../auth/firebaseAuth', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getIdToken: async () => 'id-token' }) },
}))

import { describeImagesViaSidecar } from '../visionSidecar'
import { resolveAuxByokRoute } from '../byokRouting'

const IMAGE_PART = {
  type: 'image_url' as const,
  image_url: { url: 'data:image/png;base64,AAA' },
}

function mockFetch(opts: {
  status?: number
  configKey?: string | null
  body?: unknown
  text?: string
} = {}) {
  const fn = jest.fn(async () => {
    const status = opts.status ?? 200
    const headers = new Map<string, string>()
    const key = opts.configKey === undefined ? 'sidecar:vision' : opts.configKey
    if (key !== null) headers.set('x-tm-config-key', key)
    headers.set('x-tm-model', 'qwen3.7-plus')
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h: string) => headers.get(h.toLowerCase()) ?? null },
      json: async () => opts.body ?? { choices: [{ message: { content: 'Image 1: a red button' } }] },
      text: async () => opts.text ?? '',
    } as unknown as Response
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return fn
}

describe('describeImagesViaSidecar', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(resolveAuxByokRoute as jest.Mock).mockReturnValue(null)
  })

  it('extracts a plain content string', async () => {
    mockFetch()
    await expect(describeImagesViaSidecar([IMAGE_PART])).resolves.toBe('Image 1: a red button')
  })

  it('extracts reasoning_content when visible content is empty (thinking ON)', async () => {
    mockFetch({
      body: {
        choices: [{
          message: { content: '', reasoning_content: 'Image 1: studio picker with three project cards' },
        }],
      },
    })
    await expect(describeImagesViaSidecar([IMAGE_PART])).resolves.toBe(
      'Image 1: studio picker with three project cards',
    )
  })

  it('extracts content parts arrays from OpenAI-compatible gateways', async () => {
    mockFetch({
      body: {
        choices: [{
          message: {
            content: [
              { type: 'text', text: 'Image 1: ' },
              { type: 'text', text: 'a navbar and a hero' },
            ],
          },
        }],
      },
    })
    await expect(describeImagesViaSidecar([IMAGE_PART])).resolves.toBe('Image 1: a navbar and a hero')
  })

  it('asks the sidecar to disable thinking so the description lands in content', async () => {
    const fetchFn = mockFetch()
    await describeImagesViaSidecar([IMAGE_PART])
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
    const sent = JSON.parse(String(init.body)) as { enable_thinking?: boolean }
    expect(sent.enable_thinking).toBe(false)
    expect((init.headers as Record<string, string>)['X-Request-Type']).toBe('vision')
  })

  it('returns null when sidecar:vision is unpublished (503)', async () => {
    mockFetch({
      status: 503,
      configKey: 'active',
      text: '{"error":{"code":"tm_sidecar_unavailable"}}',
    })
    await expect(describeImagesViaSidecar([IMAGE_PART])).resolves.toBeNull()
  })

  it('returns null when a non-vision config served the request', async () => {
    mockFetch({ configKey: 'persona:standard' })
    await expect(describeImagesViaSidecar([IMAGE_PART])).resolves.toBeNull()
  })

  it('returns null when there are no image parts', async () => {
    await expect(describeImagesViaSidecar([{ type: 'text', text: 'hi' }])).resolves.toBeNull()
  })
})
