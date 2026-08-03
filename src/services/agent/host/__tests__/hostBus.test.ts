/**
 * hostBus — a costura P1 do AgentHost (docs/DESIGN-HEADLESS-RUNNER.md).
 * O contrato que importa: sem handler tudo é no-op (semântica headless),
 * `once` dispara uma única vez, unsubscribe funciona, e um subscritor
 * partido nunca trava os restantes.
 */

import {
  emitAgentStopRequested,
  onAgentStopRequested,
  notifyHost,
  setHostNotificationHandler,
  emitToolProgress,
  setToolProgressHandler,
  type HostNotification,
  type ToolProgressEvent,
} from '../hostBus'

afterEach(() => {
  setHostNotificationHandler(null)
  setToolProgressHandler(null)
})

describe('onAgentStopRequested / emitAgentStopRequested', () => {
  it('entrega o stop a todos os subscritores', () => {
    const a = jest.fn()
    const b = jest.fn()
    const offA = onAgentStopRequested(a)
    const offB = onAgentStopRequested(b)
    emitAgentStopRequested()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    offB()
  })

  it('once dispara uma única vez e auto-remove-se', () => {
    const handler = jest.fn()
    onAgentStopRequested(handler, { once: true })
    emitAgentStopRequested()
    emitAgentStopRequested()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe remove o handler (incluindo antes do primeiro fire)', () => {
    const handler = jest.fn()
    const off = onAgentStopRequested(handler, { once: true })
    off()
    emitAgentStopRequested()
    expect(handler).not.toHaveBeenCalled()
  })

  it('um subscritor que lança não trava os seguintes', () => {
    const boom = jest.fn(() => {
      throw new Error('boom')
    })
    const after = jest.fn()
    const offBoom = onAgentStopRequested(boom)
    const offAfter = onAgentStopRequested(after)
    expect(() => emitAgentStopRequested()).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    offBoom()
    offAfter()
  })
})

describe('notifyHost', () => {
  it('sem handler registado é no-op (semântica headless)', () => {
    expect(() =>
      notifyHost({ title: 't', body: 'b' }),
    ).not.toThrow()
  })

  it('entrega a notificação ao handler registado, payload intacto', () => {
    const seen: HostNotification[] = []
    setHostNotificationHandler((n) => seen.push(n))
    notifyHost({ title: '✅ done', body: 'x', dedupKey: 'k', evenWhenFocused: true })
    expect(seen).toEqual([
      { title: '✅ done', body: 'x', dedupKey: 'k', evenWhenFocused: true },
    ])
  })

  it('um handler que lança não propaga ao caller', () => {
    setHostNotificationHandler(() => {
      throw new Error('boom')
    })
    expect(() => notifyHost({ title: 't', body: 'b' })).not.toThrow()
  })
})

describe('emitToolProgress (P3 — portão nº4)', () => {
  it('sem handler é no-op (semântica headless)', () => {
    expect(() =>
      emitToolProgress({ kind: 'progress', toolCallId: 'tc-1', text: 'Running...' }),
    ).not.toThrow()
  })

  it('entrega progresso e logs ao handler, payload intacto e por ordem', () => {
    const seen: ToolProgressEvent[] = []
    setToolProgressHandler((e) => seen.push(e))
    emitToolProgress({ kind: 'progress', toolCallId: 'tc-1', text: 'Installing dependencies...' })
    emitToolProgress({ kind: 'command_logs', toolCallId: 'tc-1', chunks: ['a', 'b'] })
    expect(seen).toEqual([
      { kind: 'progress', toolCallId: 'tc-1', text: 'Installing dependencies...' },
      { kind: 'command_logs', toolCallId: 'tc-1', chunks: ['a', 'b'] },
    ])
  })

  it('um handler que lança não propaga ao executor', () => {
    setToolProgressHandler(() => {
      throw new Error('boom')
    })
    expect(() =>
      emitToolProgress({ kind: 'progress', toolCallId: 'tc-1', text: 'x' }),
    ).not.toThrow()
  })
})
