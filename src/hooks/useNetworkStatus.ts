import { useEffect, useRef, useState } from 'react'
import { IS_WINDOWS } from '../utils/platform'

export type NetworkStatus = 'online' | 'offline' | 'slow'

const DEFAULT_WORKER = (import.meta.env.DEV && IS_WINDOWS) ? 'http://192.168.64.1:8787' : 'http://localhost:8787'
const WORKER_URL = import.meta.env.VITE_WORKER_URL || DEFAULT_WORKER
const PING_INTERVAL_MS = 30_000
const PING_TIMEOUT_MS = 5_000
const SLOW_THRESHOLD_MS = 2_500

export function useNetworkStatus(): { status: NetworkStatus; lastChecked: number | null; recheck: () => void } {
  const [status, setStatus] = useState<NetworkStatus>(
    typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online',
  )
  const [lastChecked, setLastChecked] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const pingingRef = useRef(false)

  const runPing = async () => {
    if (pingingRef.current) return
    pingingRef.current = true
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
    const started = Date.now()

    try {
      const res = await fetch(`${WORKER_URL}/v1/health`, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      })
      const elapsed = Date.now() - started
      if (!res.ok) {
        setStatus('offline')
      } else if (elapsed > SLOW_THRESHOLD_MS) {
        setStatus('slow')
      } else {
        setStatus('online')
      }
    } catch {
      // Network error, CORS block, or timeout → treat as offline.
      // navigator.onLine is the fallback — browsers report this reliably.
      setStatus(navigator.onLine ? 'slow' : 'offline')
    } finally {
      clearTimeout(timeoutId)
      setLastChecked(Date.now())
      pingingRef.current = false
    }
  }

  useEffect(() => {
    const onOnline = () => { setStatus('online'); runPing() }
    const onOffline = () => setStatus('offline')
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    runPing()
    const interval = setInterval(runPing, PING_INTERVAL_MS)

    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      clearInterval(interval)
      abortRef.current?.abort()
    }
  }, [])

  return { status, lastChecked, recheck: runPing }
}
