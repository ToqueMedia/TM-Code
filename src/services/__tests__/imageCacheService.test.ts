/**
 * Tests for the pasted-image disk cache (storeSessionImages / removeSessionImageCache).
 * Mocks the Tauri fs + path layers so we assert the filtering, write calls and
 * returned id→path map without touching disk.
 */
const mockMkdir = jest.fn().mockResolvedValue(undefined)
const mockWriteFile = jest.fn().mockResolvedValue(undefined)
const mockRemove = jest.fn().mockResolvedValue(undefined)

jest.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: (...a: unknown[]) => mockMkdir(...a),
  writeFile: (...a: unknown[]) => mockWriteFile(...a),
  remove: (...a: unknown[]) => mockRemove(...a),
}))

jest.mock('@tauri-apps/api/path', () => ({
  appDataDir: jest.fn().mockResolvedValue('/app/data'),
  join: (...parts: string[]) => Promise.resolve(parts.join('/')),
}))

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import { storeSessionImages, removeSessionImageCache } from '../imageCacheService'
import type { Attachment } from '../../types/chat'

// 1x1 transparent PNG data URI (valid base64).
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function img(over: Partial<Attachment> = {}): Attachment {
  return { id: 'a1', type: 'image', name: 'pasted-image.png', path: '', mimeType: 'image/png', base64: PNG_DATA_URI, ...over }
}

beforeEach(() => {
  mockMkdir.mockClear()
  mockWriteFile.mockClear()
  mockRemove.mockClear()
})

describe('storeSessionImages', () => {
  it('writes a pasted image and returns its id→path under the session dir', async () => {
    const result = await storeSessionImages('sess1', [img({ id: 'x9' })])
    expect(result).toEqual({ x9: '/app/data/image-cache/sess1/x9.png' })
    expect(mockMkdir).toHaveBeenCalledWith('/app/data/image-cache/sess1', { recursive: true })
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    // Second arg is the decoded bytes (Uint8Array), not the base64 string.
    expect(mockWriteFile.mock.calls[0][1]).toBeInstanceOf(Uint8Array)
    expect((mockWriteFile.mock.calls[0][1] as Uint8Array).length).toBeGreaterThan(0)
  })

  it('skips images that already have a disk path', async () => {
    const result = await storeSessionImages('s', [img({ path: '/real/file.png' })])
    expect(result).toEqual({})
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('skips non-image attachments and base64-less images', async () => {
    const result = await storeSessionImages('s', [
      { id: 'f1', type: 'file', name: 'a.ts', path: '/a.ts' },
      img({ id: 'noB64', base64: undefined }),
    ])
    expect(result).toEqual({})
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('derives the extension from the mime when the name has none', async () => {
    const result = await storeSessionImages('s', [
      img({ id: 'j', name: 'pasted', mimeType: 'image/jpeg', base64: PNG_DATA_URI }),
    ])
    expect(result.j).toBe('/app/data/image-cache/s/j.jpg')
  })

  it('returns {} for empty attachments or missing session id', async () => {
    expect(await storeSessionImages('s', [])).toEqual({})
    expect(await storeSessionImages('', [img()])).toEqual({})
    expect(await storeSessionImages('s', undefined)).toEqual({})
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})

describe('removeSessionImageCache', () => {
  it('removes the session cache directory recursively', async () => {
    await removeSessionImageCache('sess1')
    expect(mockRemove).toHaveBeenCalledWith('/app/data/image-cache/sess1', { recursive: true })
  })

  it('no-ops on empty session id', async () => {
    await removeSessionImageCache('')
    expect(mockRemove).not.toHaveBeenCalled()
  })
})
