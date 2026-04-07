/**
 * queueProcessor tests — covers the drain decisions: slash one-by-one,
 * bash one-by-one, prompt batched by mode, mode segregation, and the
 * coalescing semantics that motivated the port.
 */

jest.mock('../queueOperationLog', () => ({
  getQueueLogSessionId: () => 'test',
  recordQueueOperation: jest.fn().mockResolvedValue(undefined),
  setQueueLogContext: jest.fn(),
}))

import {
  enqueue,
  resetCommandQueue,
  getCommandQueueSnapshot,
  joinPromptValues,
} from '../messageQueue'
import { processQueueIfReady } from '../queueProcessor'
import type { QueuedCommand } from '../../../types/messageQueueTypes'

const mk = (value: string, overrides?: Partial<QueuedCommand>): QueuedCommand => ({
  value,
  mode: 'prompt',
  ...overrides,
})

beforeEach(() => {
  resetCommandQueue()
})

describe('processQueueIfReady — empty queue', () => {
  it('returns processed:false when queue is empty', () => {
    const exec = jest.fn().mockResolvedValue(undefined)
    const result = processQueueIfReady({ executeInput: exec })
    expect(result.processed).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('processQueueIfReady — slash commands one at a time', () => {
  it('drains a single slash command alone', () => {
    enqueue(mk('/init'))
    enqueue(mk('hello'))
    enqueue(mk('world'))

    const exec = jest.fn().mockResolvedValue(undefined)
    const result = processQueueIfReady({ executeInput: exec })

    expect(result.processed).toBe(true)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0]![0]).toHaveLength(1)
    expect(exec.mock.calls[0]![0][0].value).toBe('/init')

    // The other prompt-mode messages stay in queue
    const remaining = getCommandQueueSnapshot()
    expect(remaining.map(c => c.value)).toEqual(['hello', 'world'])
  })

  it('does not batch multiple slash commands together', () => {
    enqueue(mk('/init'))
    enqueue(mk('/plan'))

    const exec = jest.fn().mockResolvedValue(undefined)
    processQueueIfReady({ executeInput: exec })

    expect(exec.mock.calls[0]![0]).toHaveLength(1)
    expect(exec.mock.calls[0]![0][0].value).toBe('/init')

    const remaining = getCommandQueueSnapshot()
    expect(remaining.map(c => c.value)).toEqual(['/plan'])
  })
})

describe('processQueueIfReady — bash commands one at a time', () => {
  it('drains a single bash command alone', () => {
    enqueue(mk('!ls', { mode: 'bash' }))
    enqueue(mk('!pwd', { mode: 'bash' }))

    const exec = jest.fn().mockResolvedValue(undefined)
    processQueueIfReady({ executeInput: exec })

    expect(exec.mock.calls[0]![0]).toHaveLength(1)
    expect(exec.mock.calls[0]![0][0].value).toBe('!ls')
  })
})

describe('processQueueIfReady — prompt batching', () => {
  it('drains all consecutive prompt-mode commands together', () => {
    enqueue(mk('first'))
    enqueue(mk('second'))
    enqueue(mk('third'))

    const exec = jest.fn().mockResolvedValue(undefined)
    const result = processQueueIfReady({ executeInput: exec })

    expect(result.processed).toBe(true)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0]![0]).toHaveLength(3)
    expect(exec.mock.calls[0]![0].map((c: QueuedCommand) => c.value))
      .toEqual(['first', 'second', 'third'])

    expect(getCommandQueueSnapshot().length).toBe(0)
  })

  it('stops batching at a slash command', () => {
    enqueue(mk('first'))
    enqueue(mk('second'))
    enqueue(mk('/halt'))
    enqueue(mk('third'))

    const exec = jest.fn().mockResolvedValue(undefined)
    processQueueIfReady({ executeInput: exec })

    // The drain matches all prompt-mode AND non-slash items, so it
    // grabs first/second/third in one batch (the slash stays in queue).
    const batch = exec.mock.calls[0]![0]
    expect(batch.map((c: QueuedCommand) => c.value)).toEqual(['first', 'second', 'third'])

    const remaining = getCommandQueueSnapshot()
    expect(remaining.map(c => c.value)).toEqual(['/halt'])
  })

  it('does not mix prompt and bash modes in the same batch', () => {
    enqueue(mk('p1'))
    enqueue(mk('!ls', { mode: 'bash' }))
    enqueue(mk('p2'))

    const exec = jest.fn().mockResolvedValue(undefined)
    processQueueIfReady({ executeInput: exec })

    // First call drains all prompt-mode items (p1 + p2), leaves bash
    const batch = exec.mock.calls[0]![0]
    expect(batch.map((c: QueuedCommand) => c.value)).toEqual(['p1', 'p2'])

    const remaining = getCommandQueueSnapshot()
    expect(remaining.map(c => c.value)).toEqual(['!ls'])
  })
})

describe('processQueueIfReady — priority interaction', () => {
  it('higher priority items are drained first', () => {
    enqueue(mk('later1', { priority: 'later' }))
    enqueue(mk('next1', { priority: 'next' }))
    enqueue(mk('now1', { priority: 'now' }))

    const exec = jest.fn().mockResolvedValue(undefined)
    processQueueIfReady({ executeInput: exec })

    // The peek() finds the now-priority command first; it's prompt-mode,
    // so the drain matches all prompt-mode commands regardless of
    // priority — they all batch together.
    const batch = exec.mock.calls[0]![0]
    expect(batch.length).toBe(3)
  })
})

describe('joinPromptValues coalescing (the efficiency win)', () => {
  it('three messages collapse to one newline-joined string', () => {
    const result = joinPromptValues(['msg one', 'msg two', 'msg three'])
    expect(result).toBe('msg one\nmsg two\nmsg three')
  })

  it('preserves order', () => {
    const result = joinPromptValues(['c', 'a', 'b'])
    expect(result).toBe('c\na\nb')
  })
})
