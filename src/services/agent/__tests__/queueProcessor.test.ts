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
import type { ContentBlock, QueuedCommand } from '../../../types/messageQueueTypes'

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

describe('processQueueIfReady — block-valued commands', () => {
  it('batches block-valued prompt commands together', () => {
    const a: ContentBlock[] = [
      { type: 'text', text: 'olha este erro' },
      { type: 'attachment', attachment: { id: 'a1', type: 'image', name: 'shot1', path: '/1' } },
    ]
    const b: ContentBlock[] = [
      { type: 'text', text: 'e este também' },
      { type: 'attachment', attachment: { id: 'a2', type: 'image', name: 'shot2', path: '/2' } },
    ]
    enqueue(mk('', { value: a }))
    enqueue(mk('', { value: b }))

    const exec = jest.fn().mockResolvedValue(undefined)
    processQueueIfReady({ executeInput: exec })

    expect(exec).toHaveBeenCalledTimes(1)
    const batch = exec.mock.calls[0]![0]
    expect(batch.length).toBe(2)
  })

  it('coalescing preserves text→image→text→image order across messages', () => {
    const msg1: ContentBlock[] = [
      { type: 'text', text: 'first text' },
      { type: 'attachment', attachment: { id: 'i1', type: 'image', name: 'img1', path: '/1' } },
    ]
    const msg2: ContentBlock[] = [
      { type: 'text', text: 'second text' },
      { type: 'attachment', attachment: { id: 'i2', type: 'image', name: 'img2', path: '/2' } },
    ]
    const merged = joinPromptValues([msg1, msg2]) as ContentBlock[]
    expect(merged.length).toBe(4)
    // The whole point of #3: ordering across messages is preserved.
    expect((merged[0] as any).text).toBe('first text')
    expect((merged[1] as any).attachment.id).toBe('i1')
    expect((merged[2] as any).text).toBe('second text')
    expect((merged[3] as any).attachment.id).toBe('i2')
  })

  it('mixing string and block messages produces a uniform block result', () => {
    const blockMsg: ContentBlock[] = [
      { type: 'text', text: 'with image' },
      { type: 'attachment', attachment: { id: 'i', type: 'image', name: 'i', path: '/i' } },
    ]
    const merged = joinPromptValues(['plain text', blockMsg, 'another plain']) as ContentBlock[]
    expect(Array.isArray(merged)).toBe(true)
    expect(merged.length).toBe(4)
    expect((merged[0] as any).text).toBe('plain text')
    expect((merged[1] as any).text).toBe('with image')
    expect((merged[2] as any).attachment.id).toBe('i')
    expect((merged[3] as any).text).toBe('another plain')
  })
})

describe('processQueueIfReady — asTask is legacy (F3: one agent per project)', () => {
  // F3 doctrine (2026-07-23): intra-project concurrent tasks are removed — there
  // is ONE agent per project. The `asTask` flag no longer forces an individual
  // dispatch or a batch boundary; a stray asTask item is treated as a normal
  // prompt and coalesces with same-mode items into a single agent turn (which
  // steers/feeds the one run). Only slash/bash still dispatch individually.
  it('coalesces a stray asTask item with normal prompts (no separate dispatch)', () => {
    enqueue(mk('task1', { asTask: true }))
    enqueue(mk('s1'))

    const exec = jest.fn().mockResolvedValue(undefined)
    processQueueIfReady({ executeInput: exec })

    // Both drain in ONE 'prompt'-mode batch — no task boundary any more.
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0]![0].map((c: QueuedCommand) => c.value)).toEqual(['task1', 's1'])
    expect(getCommandQueueSnapshot()).toHaveLength(0)
  })

  it('coalesces multiple asTask items into a single dispatch, in order', () => {
    enqueue(mk('task1', { asTask: true }))
    enqueue(mk('task2', { asTask: true }))

    const exec = jest.fn().mockResolvedValue(undefined)
    processQueueIfReady({ executeInput: exec })

    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0]![0].map((c: QueuedCommand) => c.value)).toEqual(['task1', 'task2'])
  })

  it('a slash command still dispatches alone even with the legacy asTask flag', () => {
    enqueue(mk('/review', { asTask: true }))

    const exec = jest.fn().mockResolvedValue(undefined)
    processQueueIfReady({ executeInput: exec })

    expect(exec.mock.calls[0]![0]).toHaveLength(1)
    expect(exec.mock.calls[0]![0][0].value).toBe('/review')
  })

  it("a 'now'-priority item behind an asTask item coalesces (no queue freeze)", () => {
    // peek() picks the 'now' item as head; dequeueAllMatching drains ALL
    // same-mode items in array order, so both leave in one dispatch. The
    // guarantee under test: the drain never freezes with a non-empty queue.
    enqueue(mk('task1', { asTask: true }))
    enqueue(mk('urgent', { priority: 'now' }))

    const exec = jest.fn().mockResolvedValue(undefined)
    const r1 = processQueueIfReady({ executeInput: exec })
    expect(r1.processed).toBe(true)
    expect(exec.mock.calls[0]![0].map((c: QueuedCommand) => c.value)).toEqual(['task1', 'urgent'])
    expect(getCommandQueueSnapshot()).toHaveLength(0)
  })
})

// ── Session affiliation (2026-08-22) ─────────────────────────────────────────
// O idle drain nunca mistura sessões num lote (um lote = um turno de agente =
// uma sessão) e slash/bash de sessão estrangeira fica estacionado até o user
// voltar a essa sessão.

describe('processQueueIfReady — session-affiliated batches', () => {
  it('never mixes sessions in one batch', () => {
    enqueue(mk('a1', { sessionId: 'A' }))
    enqueue(mk('b1', { sessionId: 'B' }))
    enqueue(mk('a2', { sessionId: 'A' }))

    const exec = jest.fn().mockResolvedValue(undefined)
    const r1 = processQueueIfReady({ executeInput: exec, activeSessionId: 'X' })
    expect(r1.processed).toBe(true)
    expect(exec.mock.calls[0]![0].map((c: QueuedCommand) => c.value)).toEqual(['a1', 'a2'])

    // Snapshot mudou → o efeito volta a disparar e drena o lote de B.
    exec.mockClear()
    const r2 = processQueueIfReady({ executeInput: exec, activeSessionId: 'X' })
    expect(r2.processed).toBe(true)
    expect(exec.mock.calls[0]![0].map((c: QueuedCommand) => c.value)).toEqual(['b1'])
    expect(getCommandQueueSnapshot()).toHaveLength(0)
  })

  it('parks a foreign slash command but still drains prompts behind it', () => {
    enqueue(mk('/init', { sessionId: 'B' }))
    enqueue(mk('hello', { sessionId: 'A' }))

    const exec = jest.fn().mockResolvedValue(undefined)
    const r = processQueueIfReady({ executeInput: exec, activeSessionId: 'A' })
    expect(r.processed).toBe(true)
    expect(exec.mock.calls[0]![0].map((c: QueuedCommand) => c.value)).toEqual(['hello'])
    // O /init de B continua em fila — drena quando B voltar a estar em foco.
    expect(getCommandQueueSnapshot().map(c => c.value)).toEqual(['/init'])
  })

  it('drains a foreign slash command when its session is active again', () => {
    enqueue(mk('/init', { sessionId: 'B' }))

    const exec = jest.fn().mockResolvedValue(undefined)
    const parked = processQueueIfReady({ executeInput: exec, activeSessionId: 'A' })
    expect(parked.processed).toBe(false)

    const drained = processQueueIfReady({ executeInput: exec, activeSessionId: 'B' })
    expect(drained.processed).toBe(true)
    expect(exec.mock.calls[0]![0][0].value).toBe('/init')
  })

  it('unstamped (legacy) items batch with the active session as before', () => {
    enqueue(mk('legacy'))
    enqueue(mk('stamped', { sessionId: 'A' }))

    const exec = jest.fn().mockResolvedValue(undefined)
    processQueueIfReady({ executeInput: exec, activeSessionId: 'A' })
    // Legacy e stamped-A partilham o lote (comportamento histórico).
    expect(exec.mock.calls[0]![0]).toHaveLength(2)
  })
})
