/**
 * messageQueue tests — covers priority ordering, FIFO within priority,
 * filter dequeue, dequeueAllMatching, remove by reference, snapshot
 * frozen identity, and slash detection.
 */

// Mock the operation log so tests don't try to invoke Tauri.
jest.mock('../queueOperationLog', () => ({
  getQueueLogSessionId: () => 'test',
  recordQueueOperation: jest.fn().mockResolvedValue(undefined),
  setQueueLogContext: jest.fn(),
}))

import {
  enqueue,
  dequeue,
  dequeueAllMatching,
  peek,
  remove,
  clearCommandQueue,
  resetCommandQueue,
  hasCommandsInQueue,
  getCommandQueueSnapshot,
  isSlashCommand,
  joinPromptValues,
  canBatchWith,
} from '../messageQueue'
import type { ContentBlock, QueuedCommand } from '../../../types/messageQueueTypes'

const mk = (value: string, overrides?: Partial<QueuedCommand>): QueuedCommand => ({
  value,
  mode: 'prompt',
  ...overrides,
})

beforeEach(() => {
  resetCommandQueue()
})

describe('messageQueue — basic operations', () => {
  it('starts empty', () => {
    expect(hasCommandsInQueue()).toBe(false)
    expect(getCommandQueueSnapshot()).toEqual([])
  })

  it('enqueue adds to the queue', () => {
    enqueue(mk('hello'))
    expect(hasCommandsInQueue()).toBe(true)
    expect(getCommandQueueSnapshot().length).toBe(1)
  })

  it('enqueue defaults priority to next', () => {
    enqueue(mk('hello'))
    expect(getCommandQueueSnapshot()[0]!.priority).toBe('next')
  })

  it('enqueue preserves explicit priority', () => {
    enqueue(mk('urgent', { priority: 'now' }))
    expect(getCommandQueueSnapshot()[0]!.priority).toBe('now')
  })

  it('dequeue returns undefined when empty', () => {
    expect(dequeue()).toBeUndefined()
  })

  it('dequeue removes the returned command', () => {
    enqueue(mk('a'))
    enqueue(mk('b'))
    const c = dequeue()
    expect(c?.value).toBe('a')
    expect(getCommandQueueSnapshot().length).toBe(1)
  })

  it('clearCommandQueue empties the queue', () => {
    enqueue(mk('a'))
    enqueue(mk('b'))
    clearCommandQueue()
    expect(hasCommandsInQueue()).toBe(false)
  })
})

describe('messageQueue — priority ordering', () => {
  it('higher priority is dequeued first (now > next > later)', () => {
    enqueue(mk('later1', { priority: 'later' }))
    enqueue(mk('next1', { priority: 'next' }))
    enqueue(mk('now1', { priority: 'now' }))
    enqueue(mk('next2', { priority: 'next' }))

    expect(dequeue()?.value).toBe('now1')
    expect(dequeue()?.value).toBe('next1') // FIFO within next
    expect(dequeue()?.value).toBe('next2')
    expect(dequeue()?.value).toBe('later1')
  })

  it('FIFO within the same priority level', () => {
    enqueue(mk('first', { priority: 'next' }))
    enqueue(mk('second', { priority: 'next' }))
    enqueue(mk('third', { priority: 'next' }))

    expect(dequeue()?.value).toBe('first')
    expect(dequeue()?.value).toBe('second')
    expect(dequeue()?.value).toBe('third')
  })
})

describe('messageQueue — filter dequeue', () => {
  it('dequeue with filter skips non-matching commands', () => {
    enqueue(mk('skip', { uuid: 'A' }))
    enqueue(mk('keep', { uuid: 'B' }))
    const cmd = dequeue(c => c.uuid === 'B')
    expect(cmd?.value).toBe('keep')
    expect(getCommandQueueSnapshot().length).toBe(1)
    expect(getCommandQueueSnapshot()[0]!.value).toBe('skip')
  })

  it('peek with filter does not remove', () => {
    enqueue(mk('skip', { uuid: 'A' }))
    enqueue(mk('keep', { uuid: 'B' }))
    const cmd = peek(c => c.uuid === 'B')
    expect(cmd?.value).toBe('keep')
    expect(getCommandQueueSnapshot().length).toBe(2)
  })

  it('dequeue with filter respects priority within matching set', () => {
    enqueue(mk('low', { uuid: 'X', priority: 'later' }))
    enqueue(mk('high', { uuid: 'X', priority: 'now' }))
    enqueue(mk('other', { uuid: 'Y', priority: 'now' }))
    const cmd = dequeue(c => c.uuid === 'X')
    expect(cmd?.value).toBe('high')
  })
})

describe('messageQueue — dequeueAllMatching', () => {
  it('removes only matching commands, preserving order', () => {
    enqueue(mk('a', { mode: 'prompt' }))
    enqueue(mk('b', { mode: 'bash' }))
    enqueue(mk('c', { mode: 'prompt' }))
    enqueue(mk('d', { mode: 'bash' }))

    const matched = dequeueAllMatching(c => c.mode === 'prompt')
    expect(matched.map(m => m.value)).toEqual(['a', 'c'])

    const remaining = getCommandQueueSnapshot()
    expect(remaining.map(r => r.value)).toEqual(['b', 'd'])
  })

  it('returns empty array when nothing matches', () => {
    enqueue(mk('a'))
    const matched = dequeueAllMatching(c => c.value === 'nope')
    expect(matched).toEqual([])
    expect(getCommandQueueSnapshot().length).toBe(1)
  })
})

describe('messageQueue — remove by reference', () => {
  it('removes only the passed references', () => {
    enqueue(mk('a'))
    enqueue(mk('b'))
    enqueue(mk('c'))

    const snapshot = getCommandQueueSnapshot()
    const toRemove = snapshot[1]!

    remove([toRemove])
    expect(getCommandQueueSnapshot().map(c => c.value)).toEqual(['a', 'c'])
  })

  it('ignores unknown references', () => {
    enqueue(mk('a'))
    const stranger = mk('not-in-queue')
    remove([stranger])
    expect(getCommandQueueSnapshot().length).toBe(1)
  })
})

describe('messageQueue — snapshot identity', () => {
  it('snapshot reference is stable until mutation', () => {
    enqueue(mk('a'))
    const s1 = getCommandQueueSnapshot()
    const s2 = getCommandQueueSnapshot()
    expect(s1).toBe(s2)
  })

  it('snapshot reference changes after mutation', () => {
    enqueue(mk('a'))
    const s1 = getCommandQueueSnapshot()
    enqueue(mk('b'))
    const s2 = getCommandQueueSnapshot()
    expect(s1).not.toBe(s2)
  })

  it('snapshot is frozen', () => {
    enqueue(mk('a'))
    const s = getCommandQueueSnapshot()
    expect(Object.isFrozen(s)).toBe(true)
  })
})

describe('messageQueue — slash + batching helpers', () => {
  it('isSlashCommand recognises commands starting with /', () => {
    expect(isSlashCommand(mk('/init'))).toBe(true)
    expect(isSlashCommand(mk('  /plan args'))).toBe(true)
    expect(isSlashCommand(mk('hello world'))).toBe(false)
  })

  it('isSlashCommand respects skipSlashCommands flag', () => {
    expect(isSlashCommand(mk('/init', { skipSlashCommands: true }))).toBe(false)
  })

  it('isSlashCommand on a block-valued command checks the first text block', () => {
    const cmd = mk('', {
      value: [
        { type: 'text', text: '/plan refactor auth' },
        { type: 'attachment', attachment: { id: 'a', type: 'file', name: 'foo', path: '/foo' } },
      ],
    })
    expect(isSlashCommand(cmd)).toBe(true)
  })

  it('isSlashCommand on a block-valued command returns false if first block is attachment', () => {
    const cmd = mk('', {
      value: [
        { type: 'attachment', attachment: { id: 'a', type: 'image', name: 'i', path: '/i' } },
        { type: 'text', text: '/init' },
      ],
    })
    expect(isSlashCommand(cmd)).toBe(false)
  })

  it('joinPromptValues passes through single values', () => {
    expect(joinPromptValues(['single'])).toBe('single')
  })

  it('joinPromptValues joins multiple strings with single newline (matches Claude Code)', () => {
    expect(joinPromptValues(['one', 'two', 'three'])).toBe('one\ntwo\nthree')
  })

  it('joinPromptValues with all-block inputs concatenates blocks in order', () => {
    const a: ContentBlock[] = [
      { type: 'text', text: 'msg1' },
      { type: 'attachment', attachment: { id: 'a1', type: 'image', name: '1', path: '/1' } },
    ]
    const b: ContentBlock[] = [
      { type: 'text', text: 'msg2' },
      { type: 'attachment', attachment: { id: 'a2', type: 'image', name: '2', path: '/2' } },
    ]
    const result = joinPromptValues([a, b]) as ContentBlock[]
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(4)
    expect((result[0] as any).text).toBe('msg1')
    expect((result[1] as any).attachment.id).toBe('a1')
    expect((result[2] as any).text).toBe('msg2')
    expect((result[3] as any).attachment.id).toBe('a2')
  })

  it('joinPromptValues mixing string and blocks promotes string to text block', () => {
    const blockValue: ContentBlock[] = [
      { type: 'attachment', attachment: { id: 'a1', type: 'image', name: '1', path: '/1' } },
    ]
    const result = joinPromptValues(['hello', blockValue]) as ContentBlock[]
    expect(result.length).toBe(2)
    expect((result[0] as any).type).toBe('text')
    expect((result[0] as any).text).toBe('hello')
    expect((result[1] as any).type).toBe('attachment')
  })

  it('joinPromptValues with empty string + blocks drops the empty text', () => {
    const blockValue: ContentBlock[] = [
      { type: 'text', text: 'inner' },
    ]
    const result = joinPromptValues(['', blockValue]) as ContentBlock[]
    expect(result.length).toBe(1)
    expect((result[0] as any).text).toBe('inner')
  })

  it('canBatchWith returns true for two prompt-mode commands', () => {
    expect(canBatchWith(mk('a'), mk('b'))).toBe(true)
  })

  it('canBatchWith returns false when next is undefined', () => {
    expect(canBatchWith(mk('a'), undefined)).toBe(false)
  })

  it('canBatchWith returns false for bash-mode next', () => {
    expect(canBatchWith(mk('a'), mk('b', { mode: 'bash' }))).toBe(false)
  })

  it('canBatchWith returns false for bash-mode head', () => {
    expect(canBatchWith(mk('a', { mode: 'bash' }), mk('b'))).toBe(false)
  })
})
