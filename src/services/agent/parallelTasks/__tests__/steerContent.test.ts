import { normalizeSteerItem } from '@/stores/parallelTaskStore'
import { resolveSteerItemsToContent } from '../steerContent'
import { describeImagesViaSidecar } from '../../visionSidecar'
import { resolveByokNativeVision } from '../../byokVision'
import { getProfileForPlan } from '../../modelProfiles'

jest.mock('../../../attachmentService', () => ({
  resolveAttachments: jest.fn(async () => '<file path="x.ts" />'),
  resolveImageToDataUri: jest.fn(async (att: { base64?: string; path?: string }) => {
    if (att.base64) return att.base64
    if (att.path) return `data:image/png;base64,FROM_PATH_${att.path}`
    return null
  }),
}))

jest.mock('../../visionSidecar', () => ({
  describeImagesViaSidecar: jest.fn(async () => 'Image 1: a red button labeled Submit'),
}))

jest.mock('@/stores/billingStore', () => ({
  useBillingStore: { getState: () => ({ plan: 'pro' }) },
}))

jest.mock('@/stores/agentStore', () => ({
  useAgentStore: { getState: () => ({ modelName: null }) },
}))

jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      getActiveSession: () => null,
      sessions: new Map(),
    }),
  },
}))

jest.mock('../../modelProfiles', () => ({
  MODEL_PROFILES: {
    'vision-native': { supportsAttachments: true, contextWindow: 128000, maxOutputTokens: 8192 },
  },
  getProfileForPlan: jest.fn(() => ({ supportsAttachments: false, contextWindow: 128000, maxOutputTokens: 8192 })),
}))

jest.mock('../../byokVision', () => ({
  resolveByokNativeVision: jest.fn(() => null),
}))

const imageAtt = {
  id: 'img1',
  type: 'image' as const,
  name: 'shot.png',
  path: '/tmp/shot.png',
  base64: 'data:image/png;base64,AAA',
  mimeType: 'image/png',
}

describe('steerContent / ParallelSteerItem', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(resolveByokNativeVision as jest.Mock).mockReturnValue(null)
    ;(getProfileForPlan as jest.Mock).mockReturnValue({
      supportsAttachments: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    })
    ;(describeImagesViaSidecar as jest.Mock).mockResolvedValue('Image 1: a red button labeled Submit')
  })

  it('normalizeSteerItem accepts string or object', () => {
    expect(normalizeSteerItem('hello')).toEqual({ text: 'hello' })
    expect(normalizeSteerItem({ text: 'a', blocks: [{ type: 'text', text: 'a' }] }).blocks).toHaveLength(1)
  })

  it('resolveSteerItemsToContent joins plain text steers', async () => {
    const out = await resolveSteerItemsToContent([
      { text: 'first' },
      { text: 'second' },
    ])
    expect(typeof out).toBe('string')
    expect(out as string).toContain('first')
    expect(out as string).toContain('second')
  })

  it('resolveSteerItemsToContent returns null for empty', async () => {
    expect(await resolveSteerItemsToContent([])).toBeNull()
  })

  it('resolveSteerItemsToContent includes file attachment markers for non-vision path', async () => {
    const out = await resolveSteerItemsToContent([
      {
        text: 'see this',
        blocks: [
          { type: 'text', text: 'see this' },
          {
            type: 'attachment',
            attachment: {
              id: '1',
              type: 'file',
              name: 'x.ts',
              path: '/tmp/x.ts',
            },
          },
        ],
      },
    ])
    expect(typeof out).toBe('string')
    expect(out as string).toContain('see this')
    expect(out as string).toContain('x.ts')
  })

  it('native vision path returns image_url content parts', async () => {
    ;(getProfileForPlan as jest.Mock).mockReturnValue({
      supportsAttachments: true,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    })

    const out = await resolveSteerItemsToContent([
      {
        text: 'what is this?',
        blocks: [
          { type: 'text', text: 'what is this?' },
          { type: 'attachment', attachment: imageAtt },
        ],
      },
    ])

    expect(Array.isArray(out)).toBe(true)
    const parts = out as Array<{ type: string; image_url?: { url: string }; text?: string }>
    expect(parts.some(p => p.type === 'image_url' && p.image_url?.url?.startsWith('data:image'))).toBe(true)
    expect(parts.some(p => p.type === 'text' && p.text?.includes('what is this'))).toBe(true)
    expect(describeImagesViaSidecar).not.toHaveBeenCalled()
  })

  it('non-vision path uses sidecar description text', async () => {
    ;(getProfileForPlan as jest.Mock).mockReturnValue({
      supportsAttachments: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    })

    const out = await resolveSteerItemsToContent([
      {
        text: 'describe',
        blocks: [
          { type: 'text', text: 'describe' },
          { type: 'attachment', attachment: imageAtt },
        ],
      },
    ])

    expect(typeof out).toBe('string')
    expect(out as string).toContain('image_description')
    expect(out as string).toContain('red button')
    expect(describeImagesViaSidecar).toHaveBeenCalled()
  })

  it('BYOK vision=true forces native image_url even if plan profile is blind', async () => {
    ;(resolveByokNativeVision as jest.Mock).mockReturnValue(true)
    ;(getProfileForPlan as jest.Mock).mockReturnValue({
      supportsAttachments: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    })

    const out = await resolveSteerItemsToContent([
      {
        text: 'byok vision',
        blocks: [
          { type: 'text', text: 'byok vision' },
          { type: 'attachment', attachment: imageAtt },
        ],
      },
    ])

    expect(Array.isArray(out)).toBe(true)
    const parts = out as Array<{ type: string }>
    expect(parts.some(p => p.type === 'image_url')).toBe(true)
  })
})
