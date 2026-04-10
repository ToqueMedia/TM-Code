/**
 * promptValueHelpers tests — covers the three boundary helpers that
 * translate between the queue's PromptValue representation and the
 * agent service's consumer shapes (chat display, text-only prompt,
 * multimodal content parts).
 */

import {
  buildAugmentedPrompt,
  buildContentParts,
  contentAsText,
  downgradeHistoryToText,
  extractDisplayFromValue,
  MAX_MULTIMODAL_PAYLOAD_BYTES,
  MAX_PER_IMAGE_BYTES,
} from '../promptValueHelpers'
import { t } from '../../../i18n'
import type { Attachment, ContentPart, ConversationMessage } from '../../../types/chat'
import type { ContentBlock } from '../../../types/messageQueueTypes'

const mkImage = (id: string, base64 = `data:image/png;base64,AAAA${id}`): Attachment => ({
  id,
  type: 'image',
  name: `${id}.png`,
  path: `/fake/${id}.png`,
  mimeType: 'image/png',
  base64,
})

const mkFile = (id: string): Attachment => ({
  id,
  type: 'file',
  name: `${id}.ts`,
  path: `/fake/${id}.ts`,
})

// Mock resolvers — deterministic, no Tauri calls.
//
// Reconstructed in beforeEach so any future jest.spyOn / mockImplementation
// is scoped to a single test, never leaking to siblings. The shared
// `defaultResolvers` reference is replaced fresh each time.
let noMentions: (text: string, projectPath: string) => Promise<string>
let xmlForAttachments: (atts: Attachment[]) => Promise<string>
let dataUriForImage: (att: Attachment) => Promise<string | null>
let defaultResolvers: {
  resolveMentions: typeof noMentions
  resolveAttachmentXml: typeof xmlForAttachments
  resolveImageDataUri: typeof dataUriForImage
}

beforeEach(() => {
  noMentions = async () => ''
  xmlForAttachments = async (atts: Attachment[]) =>
    atts.length === 0
      ? ''
      : '\n\n<attachments>\n' +
        atts.map(a => `<${a.type} name="${a.name}" />`).join('\n') +
        '\n</attachments>'
  dataUriForImage = async (att: Attachment) => att.base64 ?? null
  defaultResolvers = {
    resolveMentions: noMentions,
    resolveAttachmentXml: xmlForAttachments,
    resolveImageDataUri: dataUriForImage,
  }
})

describe('extractDisplayFromValue', () => {
  it('returns the string unchanged with no attachments', () => {
    expect(extractDisplayFromValue('hello world')).toEqual({
      text: 'hello world',
      attachments: [],
    })
  })

  it('returns empty text/attachments for empty string', () => {
    expect(extractDisplayFromValue('')).toEqual({ text: '', attachments: [] })
  })

  it('flattens a block array into text + attachments', () => {
    const img = mkImage('i1')
    const value: ContentBlock[] = [
      { type: 'text', text: 'first' },
      { type: 'attachment', attachment: img },
      { type: 'text', text: 'second' },
    ]
    const result = extractDisplayFromValue(value)
    expect(result.text).toBe('first\nsecond')
    expect(result.attachments).toEqual([img])
  })

  it('drops empty text blocks from the joined text', () => {
    const value: ContentBlock[] = [
      { type: 'text', text: 'keep' },
      { type: 'text', text: '' },
      { type: 'text', text: 'also keep' },
    ]
    expect(extractDisplayFromValue(value).text).toBe('keep\nalso keep')
  })
})

describe('buildAugmentedPrompt — string path', () => {
  it('returns the string unchanged when there are no mentions', async () => {
    const result = await buildAugmentedPrompt('fix the bug', '/proj', defaultResolvers)
    expect(result).toBe('fix the bug')
  })

  it('appends mention context when resolver returns text', async () => {
    const resolvers = {
      ...defaultResolvers,
      resolveMentions: async () => '\n\n<mentioned_files>\n...file contents...\n</mentioned_files>',
    }
    const result = await buildAugmentedPrompt('fix @src/foo.ts', '/proj', resolvers)
    expect(result).toContain('fix @src/foo.ts')
    expect(result).toContain('<mentioned_files>')
  })

  it('falls back to a placeholder for empty strings', async () => {
    const result = await buildAugmentedPrompt('', '/proj', defaultResolvers)
    expect(result).toBe(t('prompt.fallbackAnalyzeFiles'))
  })
})

describe('buildAugmentedPrompt — block path', () => {
  it('walks blocks in order producing text + per-attachment XML inline', async () => {
    const img1 = mkImage('a')
    const img2 = mkImage('b')
    const value: ContentBlock[] = [
      { type: 'text', text: 'first text' },
      { type: 'attachment', attachment: img1 },
      { type: 'text', text: 'second text' },
      { type: 'attachment', attachment: img2 },
    ]
    const result = await buildAugmentedPrompt(value, '/proj', defaultResolvers)

    // Verify the ordering is preserved: text1 → img1 → text2 → img2
    const idx1 = result.indexOf('first text')
    const idxA = result.indexOf('a.png')
    const idx2 = result.indexOf('second text')
    const idxB = result.indexOf('b.png')
    expect(idx1).toBeGreaterThanOrEqual(0)
    expect(idx1).toBeLessThan(idxA)
    expect(idxA).toBeLessThan(idx2)
    expect(idx2).toBeLessThan(idxB)
  })

  it('falls back to placeholder when blocks produce no text', async () => {
    const result = await buildAugmentedPrompt([], '/proj', defaultResolvers)
    expect(result).toBe(t('prompt.fallbackAnalyzeFiles'))
  })
})

describe('buildContentParts — multimodal vision path', () => {
  it('returns null when there are no image attachments', async () => {
    const result = await buildContentParts(
      'just text',
      '/proj',
      { resolveMentions: noMentions, resolveAttachmentXml: xmlForAttachments, resolveImageDataUri: dataUriForImage },
    )
    expect(result).toBeNull()
  })

  it('returns null for a block array with only text and files', async () => {
    const value: ContentBlock[] = [
      { type: 'text', text: 'look at this file' },
      { type: 'attachment', attachment: mkFile('foo') },
    ]
    const result = await buildContentParts(
      value,
      '/proj',
      { resolveMentions: noMentions, resolveAttachmentXml: xmlForAttachments, resolveImageDataUri: dataUriForImage },
    )
    expect(result).toBeNull()
  })

  it('builds interleaved text + image_url parts for a message with images', async () => {
    const img1 = mkImage('i1')
    const img2 = mkImage('i2')
    const value: ContentBlock[] = [
      { type: 'text', text: 'compare these' },
      { type: 'attachment', attachment: img1 },
      { type: 'text', text: 'and this' },
      { type: 'attachment', attachment: img2 },
    ]
    const result = await buildContentParts(
      value,
      '/proj',
      { resolveMentions: noMentions, resolveAttachmentXml: xmlForAttachments, resolveImageDataUri: dataUriForImage },
    )

    expect(result).not.toBeNull()
    expect(result!.length).toBe(4)

    // Order preserved.
    expect(result![0]).toEqual({ type: 'text', text: 'compare these' })
    expect(result![1]).toEqual({
      type: 'image_url',
      image_url: { url: img1.base64 },
    })
    expect(result![2]).toEqual({ type: 'text', text: 'and this' })
    expect(result![3]).toEqual({
      type: 'image_url',
      image_url: { url: img2.base64 },
    })
  })

  it('falls back to XML text part when an image fails to resolve', async () => {
    const brokenImg: Attachment = {
      id: 'broken',
      type: 'image',
      name: 'broken.png',
      path: '/fake/broken.png',
      // No base64 set — dataUriForImage will return null.
    }
    const goodImg = mkImage('good')
    const value: ContentBlock[] = [
      { type: 'text', text: 'mixed' },
      { type: 'attachment', attachment: brokenImg },
      { type: 'attachment', attachment: goodImg },
    ]
    const result = await buildContentParts(
      value,
      '/proj',
      { resolveMentions: noMentions, resolveAttachmentXml: xmlForAttachments, resolveImageDataUri: dataUriForImage },
    )

    expect(result).not.toBeNull()
    // text + (broken fallback xml text) + image_url for good
    expect(result!.length).toBe(3)
    expect(result![0].type).toBe('text')
    expect(result![1].type).toBe('text') // broken fallback
    expect(result![2].type).toBe('image_url')
  })

  it('mixes image and file attachments: images as image_url, files as text XML', async () => {
    const img = mkImage('pic')
    const file = mkFile('code')
    const value: ContentBlock[] = [
      { type: 'text', text: 'check this bug' },
      { type: 'attachment', attachment: img },
      { type: 'attachment', attachment: file },
    ]
    const result = await buildContentParts(
      value,
      '/proj',
      { resolveMentions: noMentions, resolveAttachmentXml: xmlForAttachments, resolveImageDataUri: dataUriForImage },
    )

    expect(result).not.toBeNull()
    expect(result!.length).toBe(3)
    expect(result![0].type).toBe('text') // user text
    expect(result![1].type).toBe('image_url') // image
    expect(result![2].type).toBe('text') // file XML
  })

  it('prepends a fallback text part when there are images but no text', async () => {
    const img = mkImage('lonely')
    const value: ContentBlock[] = [
      { type: 'attachment', attachment: img },
    ]
    const result = await buildContentParts(
      value,
      '/proj',
      { resolveMentions: noMentions, resolveAttachmentXml: xmlForAttachments, resolveImageDataUri: dataUriForImage },
    )

    expect(result).not.toBeNull()
    expect(result!.length).toBe(2)
    expect(result![0]).toEqual({
      type: 'text',
      text: t('prompt.fallbackAnalyzeImages'),
    })
    expect(result![1].type).toBe('image_url')
  })

  it('resolves mentions inside text blocks and appends to the same text part', async () => {
    const resolvers = {
      ...defaultResolvers,
      resolveMentions: async (text: string) =>
        text.includes('@') ? '\n\n<mentioned_files>resolved</mentioned_files>' : '',
    }
    const img = mkImage('i')
    const value: ContentBlock[] = [
      { type: 'text', text: 'fix @src/foo.ts' },
      { type: 'attachment', attachment: img },
    ]
    const result = await buildContentParts(value, '/proj', resolvers)

    expect(result).not.toBeNull()
    const textPart = result!.find(p => p.type === 'text') as { type: 'text'; text: string }
    expect(textPart.text).toContain('fix @src/foo.ts')
    expect(textPart.text).toContain('<mentioned_files>')
  })

  it('rejects whitespace-only text parts and prepends a fallback', async () => {
    // Reproduces bug #1 from the critical analysis: a block with text
    // that is just whitespace should NOT count as "has text" — the
    // provider would reject the empty text part. The fallback must be
    // prepended.
    const img = mkImage('w')
    const value: ContentBlock[] = [
      { type: 'text', text: '   ' }, // whitespace only
      { type: 'attachment', attachment: img },
    ]
    const result = await buildContentParts(value, '/proj', defaultResolvers)

    expect(result).not.toBeNull()
    // Whitespace text was kept (length > 0) but a fallback was prepended.
    expect(result!.length).toBeGreaterThanOrEqual(2)
    const firstText = result!.find(p => p.type === 'text') as { type: 'text'; text: string }
    expect(firstText.text).toBe(t('prompt.fallbackAnalyzeImages'))
  })

  it('drops a single image that exceeds the per-image cap, falls back to XML', async () => {
    // Test with TINY caps so we don't allocate real megabytes.
    const tinyOptions = { maxPerImageBytes: 50, maxTotalBytes: 1000 }

    // Resolver returns a 60-byte fake data URI for the "big" image,
    // exceeding the 50-byte per-image cap. The "small" image fits.
    const sizedResolver = async (att: Attachment) =>
      att.id === 'big' ? 'X'.repeat(60) : 'a'.repeat(40)
    const resolvers = { ...defaultResolvers, resolveImageDataUri: sizedResolver }

    const value: ContentBlock[] = [
      { type: 'text', text: 'compare' },
      { type: 'attachment', attachment: mkImage('big') },
      { type: 'attachment', attachment: mkImage('small') },
    ]
    const result = await buildContentParts(value, '/proj', resolvers, tinyOptions)

    expect(result).not.toBeNull()
    const imageParts = result!.filter(p => p.type === 'image_url')
    expect(imageParts.length).toBe(1) // only "small" survived
    // "big" became a text fallback containing its name.
    const textParts = result!.filter(p => p.type === 'text')
    expect(textParts.some(p => p.type === 'text' && p.text.includes('big'))).toBe(true)
  })

  it('returns null when ALL images exceed the per-image cap', async () => {
    const tinyOptions = { maxPerImageBytes: 50, maxTotalBytes: 1000 }
    // Every image resolves to oversized.
    const oversizedResolver = async () => 'X'.repeat(60)
    const resolvers = { ...defaultResolvers, resolveImageDataUri: oversizedResolver }

    const value: ContentBlock[] = [
      { type: 'text', text: 'analyze' },
      { type: 'attachment', attachment: mkImage('a') },
      { type: 'attachment', attachment: mkImage('b') },
    ]
    const result = await buildContentParts(value, '/proj', resolvers, tinyOptions)

    // No images survived → null (caller falls back to text path).
    expect(result).toBeNull()
  })

  it('returns null when surviving images exceed the total payload cap', async () => {
    // Per-image cap allows each image, but the sum exceeds the total cap.
    const tinyOptions = { maxPerImageBytes: 100, maxTotalBytes: 250 }
    // Each image is 100 bytes; 3 images = 300 > 250 total.
    const sized = async () => 'X'.repeat(100)
    const resolvers = { ...defaultResolvers, resolveImageDataUri: sized }

    const value: ContentBlock[] = [
      { type: 'text', text: 'all of these' },
      { type: 'attachment', attachment: mkImage('a') },
      { type: 'attachment', attachment: mkImage('b') },
      { type: 'attachment', attachment: mkImage('c') },
    ]
    const result = await buildContentParts(value, '/proj', resolvers, tinyOptions)

    expect(result).toBeNull()
  })

  it('uses default caps when options are omitted', async () => {
    // Sanity check that the default exports are wired correctly. We
    // don't actually exercise the cap here — just verify the call
    // shape with no options compiles and runs.
    const value: ContentBlock[] = [
      { type: 'text', text: 'small' },
      { type: 'attachment', attachment: mkImage('tiny') },
    ]
    const result = await buildContentParts(value, '/proj', defaultResolvers)

    expect(result).not.toBeNull()
    expect(MAX_MULTIMODAL_PAYLOAD_BYTES).toBeGreaterThan(0)
    expect(MAX_PER_IMAGE_BYTES).toBeGreaterThan(0)
    expect(MAX_PER_IMAGE_BYTES).toBeLessThanOrEqual(MAX_MULTIMODAL_PAYLOAD_BYTES)
  })
})

describe('contentAsText', () => {
  it('returns empty string for null', () => {
    expect(contentAsText(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(contentAsText(undefined)).toBe('')
  })

  it('returns the string unchanged when content is a string', () => {
    expect(contentAsText('hello world')).toBe('hello world')
  })

  it('joins text parts with newline for content arrays', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]
    expect(contentAsText(parts)).toBe('first\nsecond')
  })

  it('replaces image parts with [image] marker', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'before' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
      { type: 'text', text: 'after' },
    ]
    expect(contentAsText(parts)).toBe('before\n[image]\nafter')
  })
})

describe('downgradeHistoryToText', () => {
  it('passes string content through unchanged', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    const result = downgradeHistoryToText(history)
    expect(result[0].content).toBe('hello')
    expect(result[1].content).toBe('hi')
  })

  it('flattens content parts to text with image placeholder', () => {
    const history: ConversationMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'olha esta imagem' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
        ],
      },
    ]
    const result = downgradeHistoryToText(history)
    expect(typeof result[0].content).toBe('string')
    expect(result[0].content).toContain('olha esta imagem')
    // The placeholder text should match the i18n value (or contain its
    // distinguishing prefix). We assert non-empty + recognisable shape.
    expect(typeof result[0].content).toBe('string')
    expect((result[0].content as string).length).toBeGreaterThan(0)
    expect(result[0].content).toContain(t('prompt.imageStripped'))
  })

  it('does not mutate the input history', () => {
    const original: ConversationMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'msg' }],
      },
    ]
    const snapshot = JSON.parse(JSON.stringify(original))
    downgradeHistoryToText(original)
    expect(original).toEqual(snapshot)
  })

  it('preserves null content', () => {
    const history: ConversationMessage[] = [
      { role: 'assistant', content: null },
    ]
    const result = downgradeHistoryToText(history)
    expect(result[0].content).toBeNull()
  })
})
