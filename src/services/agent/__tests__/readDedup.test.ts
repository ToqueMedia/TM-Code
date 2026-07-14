import { checkReadDedup, FILE_UNCHANGED_STUB } from '../toolExecutor/readDedup'
import type { FileStateCache, FileState } from '../toolExecutor/fileStateCache'

function cacheWith(path: string, state: FileState): FileStateCache {
  return {
    get: (key: string) => key === path ? state : undefined,
  } as unknown as FileStateCache
}

describe('read_file dedup', () => {
  it('dedupes repeated full-file reads when the file is unchanged', () => {
    const cache = cacheWith('/repo/AccountCode.tsx', {
      content: 'const x = 1',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
      source: 'read',
      hash: 123,
      fsVersion: 7,
    })

    expect(checkReadDedup('/repo/AccountCode.tsx', undefined, undefined, cache, 7))
      .toEqual({ isDuplicate: true, stub: FILE_UNCHANGED_STUB })
  })

  it('does not dedupe write-sourced entries even when offset and limit are undefined', () => {
    const cache = cacheWith('/repo/AccountCode.tsx', {
      content: 'const x = 2',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
      source: 'write',
      hash: 456,
      fsVersion: 7,
    })

    expect(checkReadDedup('/repo/AccountCode.tsx', undefined, undefined, cache, 7))
      .toEqual({ isDuplicate: false, stub: null })
  })

  it('dedupes after fsVersion changes when current content exactly matches the prior read', () => {
    const cache = cacheWith('/repo/AccountCode.tsx', {
      content: 'const x = 1',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
      source: 'read',
      hash: 123,
      fsVersion: 7,
    })

    expect(checkReadDedup('/repo/AccountCode.tsx', undefined, undefined, cache, 8, 'const x = 1'))
      .toEqual({ isDuplicate: true, stub: FILE_UNCHANGED_STUB })
  })

  it('dedupes after fsVersion changes when the current signature matches the prior read', () => {
    const cache = cacheWith('/repo/AccountCode.tsx', {
      content: 'const x = 1',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
      source: 'read',
      signature: { size: 11, sha256: 'abc123', modifiedMs: 10 },
      hash: 123,
      fsVersion: 7,
    })

    expect(checkReadDedup(
      '/repo/AccountCode.tsx',
      undefined,
      undefined,
      cache,
      8,
      undefined,
      { size: 11, sha256: 'abc123', modifiedMs: 20 },
    )).toEqual({ isDuplicate: true, stub: FILE_UNCHANGED_STUB })
  })

  it('does not dedupe after fsVersion changes when the current signature differs', () => {
    const cache = cacheWith('/repo/AccountCode.tsx', {
      content: 'const x = 1',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
      source: 'read',
      signature: { size: 11, sha256: 'abc123' },
      hash: 123,
      fsVersion: 7,
    })

    expect(checkReadDedup(
      '/repo/AccountCode.tsx',
      undefined,
      undefined,
      cache,
      8,
      undefined,
      { size: 11, sha256: 'def456' },
    )).toEqual({ isDuplicate: false, stub: null })
  })

  it('does not dedupe after fsVersion changes when current content differs', () => {
    const cache = cacheWith('/repo/AccountCode.tsx', {
      content: 'const x = 1',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
      source: 'read',
      hash: 123,
      fsVersion: 7,
    })

    expect(checkReadDedup('/repo/AccountCode.tsx', undefined, undefined, cache, 8, 'const x = 2'))
      .toEqual({ isDuplicate: false, stub: null })
  })

  it('does not dedupe partial injected views', () => {
    const cache = cacheWith('/repo/TMS.md', {
      content: 'partial content',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
      source: 'read',
      hash: 123,
      fsVersion: 7,
      isPartialView: true,
    })

    expect(checkReadDedup('/repo/TMS.md', undefined, undefined, cache, 7))
      .toEqual({ isDuplicate: false, stub: null })
  })
})
