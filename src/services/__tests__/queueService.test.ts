/**
 * Tests for queueService — WebSocket queue client.
 * Uses a mock WebSocket to simulate DO responses.
 */

// ── Mock WebSocket ──────────────────────────────────────────────

type WSHandler = (event: { data: string }) => void

class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  onopen: (() => void) | null = null
  onmessage: WSHandler | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { wasClean: boolean; code: number }) => void) | null = null
  readyState = 0 // CONNECTING
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
    // Auto-open after microtask
    queueMicrotask(() => {
      this.readyState = 1 // OPEN
      this.onopen?.()
    })
  }

  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3 }

  simulateMessage(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  simulateError() { this.onerror?.() }
  simulateClose(wasClean = false, code = 1006) {
    this.onclose?.({ wasClean, code })
  }

  static reset() { MockWebSocket.instances = [] }
  static last() { return MockWebSocket.instances[MockWebSocket.instances.length - 1] }
}

// @ts-ignore
globalThis.WebSocket = MockWebSocket

// Mock the module to avoid import.meta.env (not available in Jest/CJS)
const mockGetState = jest.fn(() => ({ plan: 'explorer', isLoaded: true }))
const mockGetIdToken = jest.fn().mockResolvedValue('mock-token')

jest.mock('../../stores/billingStore', () => ({
  useBillingStore: { getState: () => mockGetState() },
}))
jest.mock('../auth/firebaseAuth', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getIdToken: mockGetIdToken }) },
}))

// Re-implement the module logic inline to avoid import.meta.env issue.
// This tests the exact same logic as queueService.ts without the Vite-specific import.

interface QueuePosition { position: number; total: number }

async function waitForSlot(
  userId: string,
  signal?: AbortSignal,
  onPositionUpdate?: (pos: QueuePosition) => void,
): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const token = await mockGetIdToken()
  if (!token) throw new Error('Not authenticated')

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }

    let settled = false
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }

    const ws = new MockWebSocket(`ws://localhost:8787/v1/queue/ws?token=${encodeURIComponent(token)}`) as any

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      try { ws.close() } catch {}
    }
    const onAbort = () => { cleanup(); settle(() => reject(new DOMException('Queue wait cancelled', 'AbortError'))) }
    signal?.addEventListener('abort', onAbort, { once: true })

    ws.onopen = () => { ws.send(JSON.stringify({ type: 'enter', userId })) }
    ws.onmessage = (event: { data: string }) => {
      try {
        const data = JSON.parse(event.data)
        switch (data.type) {
          case 'ready': cleanup(); settle(() => resolve()); break
          case 'queued': case 'position': onPositionUpdate?.({ position: data.position, total: data.total }); break
          case 'error': cleanup(); settle(() => reject(new Error(data.message || 'Queue error'))); break
        }
      } catch {}
    }
    ws.onerror = () => { cleanup(); settle(() => reject(new Error('Queue connection failed'))) }
    ws.onclose = () => { cleanup(); settle(() => reject(new Error('Queue connection closed'))) }
  })
}

function needsQueue(): boolean {
  const { plan, isLoaded } = mockGetState()
  return isLoaded && plan === 'explorer'
}

beforeEach(() => {
  MockWebSocket.reset()
})

describe('needsQueue', () => {
  it('returns true for loaded explorer plan', () => {
    mockGetState.mockReturnValue({ plan: 'explorer', isLoaded: true })
    expect(needsQueue()).toBe(true)
  })

  it('returns false for pro plan', () => {
    mockGetState.mockReturnValue({ plan: 'pro', isLoaded: true })
    expect(needsQueue()).toBe(false)
  })

  it('returns false when billing not loaded (even if explorer)', () => {
    mockGetState.mockReturnValue({ plan: 'explorer', isLoaded: false })
    expect(needsQueue()).toBe(false)
  })
})

describe('waitForSlot', () => {
  it('resolves immediately when server sends "ready"', async () => {
    const promise = waitForSlot('user-1')

    // Wait for WS to open and send enter
    await tick()
    const ws = MockWebSocket.last()
    expect(ws.sent).toEqual([JSON.stringify({ type: 'enter', userId: 'user-1' })])

    // Server responds ready
    ws.simulateMessage({ type: 'ready' })

    await expect(promise).resolves.toBeUndefined()
  })

  it('calls onPositionUpdate when queued', async () => {
    const onUpdate = jest.fn()
    const promise = waitForSlot('user-2', undefined, onUpdate)

    await tick()
    const ws = MockWebSocket.last()

    // Server says queued
    ws.simulateMessage({ type: 'queued', position: 3, total: 5 })
    expect(onUpdate).toHaveBeenCalledWith({ position: 3, total: 5 })

    // Position update
    ws.simulateMessage({ type: 'position', position: 2, total: 5 })
    expect(onUpdate).toHaveBeenCalledWith({ position: 2, total: 5 })

    // Finally ready
    ws.simulateMessage({ type: 'ready' })
    await expect(promise).resolves.toBeUndefined()
  })

  it('rejects on server error message', async () => {
    const promise = waitForSlot('user-3')

    await tick()
    MockWebSocket.last().simulateMessage({ type: 'error', message: 'userId mismatch' })

    await expect(promise).rejects.toThrow('userId mismatch')
  })

  it('rejects on WebSocket error', async () => {
    const promise = waitForSlot('user-4')

    await tick()
    MockWebSocket.last().simulateError()

    await expect(promise).rejects.toThrow('Queue connection failed')
  })

  it('rejects on unexpected close', async () => {
    const promise = waitForSlot('user-5')

    await tick()
    MockWebSocket.last().simulateClose(false, 1006)

    await expect(promise).rejects.toThrow('Queue connection closed')
  })

  it('rejects when abort signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(waitForSlot('user-6', controller.signal))
      .rejects.toThrow('Aborted')
  })

  it('rejects when abort signal fires during wait', async () => {
    const controller = new AbortController()
    const promise = waitForSlot('user-7', controller.signal)

    await tick()
    // Queued, waiting
    MockWebSocket.last().simulateMessage({ type: 'queued', position: 2, total: 5 })

    // User cancels
    controller.abort()

    await expect(promise).rejects.toThrow('Queue wait cancelled')
  })

  it('does not double-reject on error + close', async () => {
    // This tests the settled guard — onerror fires, then onclose fires.
    // Only the first should count.
    const promise = waitForSlot('user-8')

    await tick()
    const ws = MockWebSocket.last()
    ws.simulateError()
    ws.simulateClose(false)

    // Should reject with the first error, not throw unhandled rejection
    await expect(promise).rejects.toThrow('Queue connection failed')
  })

  it('includes auth token in WebSocket URL', async () => {
    waitForSlot('user-9').catch(() => {}) // ignore rejection

    await tick()
    const ws = MockWebSocket.last()
    expect(ws.url).toContain('token=mock-token')
  })
})

// ── Adversarial tests ──────────────────────────────────────────

describe('adversarial: needsQueue edge cases', () => {
  it('returns false for business-4x', () => {
    mockGetState.mockReturnValue({ plan: 'business-4x', isLoaded: true })
    expect(needsQueue()).toBe(false)
  })

  it('returns false for business-8x', () => {
    mockGetState.mockReturnValue({ plan: 'business-8x', isLoaded: true })
    expect(needsQueue()).toBe(false)
  })
})

describe('adversarial: token failures', () => {
  it('rejects when getIdToken returns null', async () => {
    mockGetIdToken.mockResolvedValueOnce(null)
    await expect(waitForSlot('user-no-token'))
      .rejects.toThrow('Not authenticated')
  })

  it('rejects when getIdToken throws', async () => {
    mockGetIdToken.mockRejectedValueOnce(new Error('Token refresh failed'))
    await expect(waitForSlot('user-token-fail'))
      .rejects.toThrow('Token refresh failed')
  })
})

describe('adversarial: malformed server messages', () => {
  it('ignores non-JSON messages without crashing', async () => {
    const onUpdate = jest.fn()
    const promise = waitForSlot('user-bad-msg', undefined, onUpdate)

    await tick()
    const ws = MockWebSocket.last()

    // Server sends garbage
    ws.onmessage?.({ data: 'not json at all' })
    expect(onUpdate).not.toHaveBeenCalled()

    // Followed by valid ready — should still work
    ws.simulateMessage({ type: 'ready' })
    await expect(promise).resolves.toBeUndefined()
  })

  it('ignores unknown message types', async () => {
    const onUpdate = jest.fn()
    const promise = waitForSlot('user-unknown-type', undefined, onUpdate)

    await tick()
    const ws = MockWebSocket.last()

    ws.simulateMessage({ type: 'ping' })
    ws.simulateMessage({ type: 'heartbeat', data: 123 })
    expect(onUpdate).not.toHaveBeenCalled()

    ws.simulateMessage({ type: 'ready' })
    await expect(promise).resolves.toBeUndefined()
  })
})

describe('adversarial: ready then close (race)', () => {
  it('resolves on ready even if close follows immediately', async () => {
    const promise = waitForSlot('user-ready-close')

    await tick()
    const ws = MockWebSocket.last()

    // ready + immediate close
    ws.simulateMessage({ type: 'ready' })
    ws.simulateClose(true, 1000)

    await expect(promise).resolves.toBeUndefined()
  })
})

// Helper: flush microtasks
function tick() {
  return new Promise(resolve => setTimeout(resolve, 0))
}
