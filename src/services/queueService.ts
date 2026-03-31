/**
 * Free-tier queue client.
 *
 * Connects to the backend Durable Object via WebSocket to manage queue
 * position for Free (explorer) users. The flow:
 *
 *   1. waitForSlot(userId) — connects WS, sends "enter", resolves on "ready"
 *   2. During wait, calls onPositionUpdate with current position
 *   3. User can abort via AbortSignal
 *   4. Slot release is handled by the backend (stream end → DO HTTP release)
 */

import { useBillingStore } from '../stores/billingStore'
import FirebaseAuthService from './auth/firebaseAuth'

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787'

export interface QueuePosition {
  position: number
  total: number
}

/**
 * Wait for a queue slot. Resolves when the slot is ready.
 * Only used for Free (explorer) plan users.
 *
 * @param userId - Firebase user ID
 * @param signal - AbortSignal to cancel the wait
 * @param onPositionUpdate - Called when queue position changes
 * @returns Promise that resolves when slot is acquired
 */
export async function waitForSlot(
  userId: string,
  signal?: AbortSignal,
  onPositionUpdate?: (pos: QueuePosition) => void,
): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  // Get auth token for WebSocket (WS doesn't support custom headers)
  const token = await FirebaseAuthService.getInstance().getIdToken()
  if (!token) throw new Error('Not authenticated')

  const wsBase = WORKER_URL.replace(/^http/, 'ws')

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    let settled = false
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }

    const ws = new WebSocket(`${wsBase}/v1/queue/ws?token=${encodeURIComponent(token)}`)

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      try { ws.close() } catch {}
    }

    const onAbort = () => {
      cleanup()
      settle(() => reject(new DOMException('Queue wait cancelled', 'AbortError')))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'enter', userId }))
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        switch (data.type) {
          case 'ready':
            cleanup()
            settle(() => resolve())
            break

          case 'queued':
          case 'position':
            onPositionUpdate?.({
              position: data.position,
              total: data.total,
            })
            break

          case 'error':
            cleanup()
            settle(() => reject(new Error(data.message || 'Queue error')))
            break
        }
      } catch {
        // Invalid message — ignore
      }
    }

    ws.onerror = () => {
      cleanup()
      settle(() => reject(new Error('Queue connection failed')))
    }

    ws.onclose = () => {
      cleanup()
      settle(() => reject(new Error('Queue connection closed')))
    }
  })
}

/** Check if the current user needs to go through the queue.
 *  Only returns true if billing data has loaded AND the plan is explorer.
 *  If billing hasn't loaded yet, skip the queue (backend enforces anyway). */
export function needsQueue(): boolean {
  const { plan, isLoaded } = useBillingStore.getState()
  return isLoaded && plan === 'explorer'
}
