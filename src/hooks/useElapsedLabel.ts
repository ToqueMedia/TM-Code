import { useEffect, useState } from 'react'

/** Format elapsed milliseconds as `m:ss` (or `h:mm:ss` past the hour). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/**
 * Live elapsed-time label for calls/presentations. `since` is a ms-epoch
 * start (null → returns null and no timer runs). Ticks once per second only
 * while mounted with an active start — cheap enough for the chat panels.
 */
export function useElapsedLabel(since: number | null): string | null {
  const [label, setLabel] = useState<string | null>(() =>
    since === null ? null : formatElapsed(Date.now() - since),
  )

  useEffect(() => {
    if (since === null) {
      setLabel(null)
      return
    }
    const update = () => setLabel(formatElapsed(Date.now() - since))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [since])

  return label
}
