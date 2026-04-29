// fake-indexeddb uses structuredClone to deep-copy values at put/get. jsdom's
// environment in older Jest setups doesn't expose it as a global — polyfill
// BEFORE the fake-indexeddb import so its first use finds the symbol.
// (Node 17+ has structuredClone; this just re-exposes it on globalThis.)
if (typeof globalThis.structuredClone === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  globalThis.structuredClone = require('node:util').structuredClone
    ?? ((v: unknown) => JSON.parse(JSON.stringify(v)))
}

// Polyfill IndexedDB for jsdom BEFORE importing the module under test —
// `openDb()` inspects `typeof indexedDB` at first call.
import 'fake-indexeddb/auto'

import {
  loadPromptHistory,
  savePromptHistory,
  clearPromptHistory,
  mergePromptHistory,
  onHistoryReset,
  MAX_PROMPT_HISTORY,
} from '../cmdPromptHistory'

// Each test uses a unique project path so leftover writes from previous tests
// never leak across cases — simpler and more deterministic than trying to
// delete the database between tests (deleteDatabase with open connections
// gets blocked and hangs under fake-indexeddb's blocking-detection logic).
let projectCounter = 0
const uniquePath = (label: string) => `/test/${label}-${++projectCounter}-${Date.now()}`

describe('mergePromptHistory (pure)', () => {
  it('returns memory verbatim when persisted is empty', () => {
    expect(mergePromptHistory(['a', 'b'], [])).toEqual(['a', 'b'])
  })

  it('returns persisted verbatim when memory is empty', () => {
    expect(mergePromptHistory([], ['c', 'd'])).toEqual(['c', 'd'])
  })

  it('puts memory entries first, appends persisted entries that are not duplicates', () => {
    expect(mergePromptHistory(['new'], ['a', 'b', 'c'])).toEqual(['new', 'a', 'b', 'c'])
  })

  it('dedups — persisted entries already present in memory are skipped', () => {
    expect(mergePromptHistory(['a', 'b'], ['b', 'c', 'a'])).toEqual(['a', 'b', 'c'])
  })

  it('caps the merged list at MAX_PROMPT_HISTORY', () => {
    const memory = Array.from({ length: 60 }, (_, i) => `m${i}`)
    const persisted = Array.from({ length: 60 }, (_, i) => `p${i}`)
    const merged = mergePromptHistory(memory, persisted)
    expect(merged).toHaveLength(MAX_PROMPT_HISTORY)
    // Memory keeps priority → all 60 memory entries survive, 40 persisted fill the tail.
    expect(merged.slice(0, 60)).toEqual(memory)
    expect(merged.slice(60)).toEqual(persisted.slice(0, 40))
  })
})

describe('loadPromptHistory / savePromptHistory', () => {
  it('load on empty store returns []', async () => {
    const path = uniquePath('load-empty')
    await expect(loadPromptHistory(path)).resolves.toEqual([])
  })

  it('save then load round-trips the exact array', async () => {
    const path = uniquePath('round-trip')
    await savePromptHistory(path, ['one', 'two', 'three'])
    await expect(loadPromptHistory(path)).resolves.toEqual(['one', 'two', 'three'])
  })

  it('save overwrites the previous entry for the same project (last-write-wins)', async () => {
    const path = uniquePath('overwrite')
    await savePromptHistory(path, ['one'])
    await savePromptHistory(path, ['two', 'three'])
    await expect(loadPromptHistory(path)).resolves.toEqual(['two', 'three'])
  })

  it('stores are isolated per project path', async () => {
    const a = uniquePath('isolated-a')
    const b = uniquePath('isolated-b')
    await savePromptHistory(a, ['a1', 'a2'])
    await savePromptHistory(b, ['b1'])
    await expect(loadPromptHistory(a)).resolves.toEqual(['a1', 'a2'])
    await expect(loadPromptHistory(b)).resolves.toEqual(['b1'])
  })

  it('save enforces MAX_PROMPT_HISTORY cap on disk', async () => {
    const path = uniquePath('cap')
    const oversized = Array.from({ length: MAX_PROMPT_HISTORY + 50 }, (_, i) => `p${i}`)
    await savePromptHistory(path, oversized)
    const loaded = await loadPromptHistory(path)
    expect(loaded).toHaveLength(MAX_PROMPT_HISTORY)
    expect(loaded[0]).toBe('p0')
    expect(loaded[MAX_PROMPT_HISTORY - 1]).toBe(`p${MAX_PROMPT_HISTORY - 1}`)
  })

  it('no-ops on empty project path', async () => {
    await expect(savePromptHistory('', ['a'])).resolves.toBeUndefined()
    await expect(loadPromptHistory('')).resolves.toEqual([])
  })
})

describe('clearPromptHistory', () => {
  it('deletes the stored entry for one project', async () => {
    const path = uniquePath('clear-one')
    await savePromptHistory(path, ['a', 'b'])
    await clearPromptHistory(path)
    await expect(loadPromptHistory(path)).resolves.toEqual([])
  })

  it('leaves other projects intact', async () => {
    const a = uniquePath('clear-isolated-a')
    const b = uniquePath('clear-isolated-b')
    await savePromptHistory(a, ['a1'])
    await savePromptHistory(b, ['b1'])
    await clearPromptHistory(a)
    await expect(loadPromptHistory(b)).resolves.toEqual(['b1'])
  })

  it('notifies registered reset listeners with the affected projectPath', async () => {
    const path = uniquePath('reset-notify')
    const events: string[] = []
    const off = onHistoryReset((p) => { events.push(p) })
    await savePromptHistory(path, ['a'])
    await clearPromptHistory(path)
    expect(events).toEqual([path])
    off()
  })

  it('onHistoryReset returns an unsubscribe fn that silences future events', async () => {
    const path = uniquePath('reset-off')
    const events: string[] = []
    const off = onHistoryReset((p) => { events.push(p) })
    off()
    await clearPromptHistory(path)
    expect(events).toEqual([])
  })
})

describe('race: load/send overlap — data loss regression guard', () => {
  it('merge preserves persisted history when a send races ahead of load', async () => {
    const path = uniquePath('race')
    // Simulate pre-existing disk state.
    await savePromptHistory(path, ['old-1', 'old-2', 'old-3'])

    // Simulate what the hook does: user sends BEFORE the async load completes.
    const inMemoryAfterSend = ['fresh-send']

    // Hook's merge-on-load step:
    const persisted = await loadPromptHistory(path)
    const merged = mergePromptHistory(inMemoryAfterSend, persisted)

    // Expected: the fresh send is most recent; the 3 persisted entries follow.
    // Pre-fix behaviour would have replaced inMemory with persisted (losing the
    // fresh send) OR — worse — the save-before-load path would have overwritten
    // disk with just ['fresh-send'], losing old-1/2/3 forever.
    expect(merged).toEqual(['fresh-send', 'old-1', 'old-2', 'old-3'])

    // Simulate persisting the merged list — now disk has everything.
    await savePromptHistory(path, merged)
    await expect(loadPromptHistory(path)).resolves.toEqual([
      'fresh-send', 'old-1', 'old-2', 'old-3',
    ])
  })
})
