import {
  __resetMemoryWriteTrackerForTests,
  hasMemoryWriteSinceTurnStart,
  markTurnStart,
  recordMemoryWrite,
} from '../memoryWriteTracker'

const SID = 'session-A'
const OTHER = 'session-B'

beforeEach(() => {
  __resetMemoryWriteTrackerForTests()
})

describe('memoryWriteTracker', () => {
  it('returns false when the session has never been started', () => {
    expect(hasMemoryWriteSinceTurnStart(SID)).toBe(false)
  })

  it('returns false when the turn started but no write happened', () => {
    markTurnStart(SID)
    expect(hasMemoryWriteSinceTurnStart(SID)).toBe(false)
  })

  it('returns true after a write that happens after turn start', async () => {
    markTurnStart(SID)
    // Sleep a tick so timestamps differ — recordMemoryWrite uses
    // Date.now() and would otherwise collide with markTurnStart on
    // sub-millisecond systems.
    await new Promise(r => setTimeout(r, 2))
    recordMemoryWrite(SID)
    expect(hasMemoryWriteSinceTurnStart(SID)).toBe(true)
  })

  it('returns false again after the next turn starts (write predates the new turn)', async () => {
    markTurnStart(SID)
    await new Promise(r => setTimeout(r, 2))
    recordMemoryWrite(SID)
    expect(hasMemoryWriteSinceTurnStart(SID)).toBe(true)
    await new Promise(r => setTimeout(r, 2))
    markTurnStart(SID)
    expect(hasMemoryWriteSinceTurnStart(SID)).toBe(false)
  })

  it('isolates state across sessions', async () => {
    markTurnStart(SID)
    markTurnStart(OTHER)
    await new Promise(r => setTimeout(r, 2))
    recordMemoryWrite(SID)
    expect(hasMemoryWriteSinceTurnStart(SID)).toBe(true)
    expect(hasMemoryWriteSinceTurnStart(OTHER)).toBe(false)
  })

  it('recordMemoryWrite without a prior markTurnStart does not falsely signal', () => {
    recordMemoryWrite(SID)
    // No turn start → no window → no signal
    expect(hasMemoryWriteSinceTurnStart(SID)).toBe(false)
  })
})
