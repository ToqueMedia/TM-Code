import { useCallback, useEffect, useRef, useState } from 'react'
import { useCollabStore } from '@/stores/collabStore'
import { useAuthStore } from '@/stores/authStore'
import { sendTypingState } from '@/services/collab/collabSessionService'
import { t } from '@/i18n'

// Team-chat typing indicator. Encapsulates BOTH sides so the two chat panels
// (floating + terminal) stay in sync:
//   - broadcast: `notifyTyping(hasText)` pings the team at most every PING_MS
//     while the composer has text, and auto-sends a "stopped" after a short
//     idle; `stopTyping()` clears immediately (on send / blur / unmount).
//   - read: `typingLabel` is the localized "X is typing…" string, recomputed
//     from `typingPeers` and self-ticking so a stale entry (a peer that closed
//     mid-typing) expires after TTL_MS instead of sticking forever.

const TYPING_TTL_MS = 5000
const TYPING_PING_MS = 2500

export function useTeamTyping() {
  const typingPeers = useCollabStore((s) => s.typingPeers)
  const selfUid = useAuthStore((s) => s.user?.uid)
  const lastPingRef = useRef(0)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, force] = useState(0)

  const stopTyping = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    if (lastPingRef.current) {
      lastPingRef.current = 0
      sendTypingState(false)
    }
  }, [])

  const notifyTyping = useCallback(
    (hasText: boolean) => {
      if (!hasText) {
        stopTyping()
        return
      }
      const now = Date.now()
      if (now - lastPingRef.current > TYPING_PING_MS) {
        lastPingRef.current = now
        sendTypingState(true)
      }
      // Reset the idle auto-stop on every keystroke.
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
      stopTimerRef.current = setTimeout(stopTyping, TYPING_PING_MS + 800)
    },
    [stopTyping],
  )

  // Clear our broadcast state if the panel unmounts mid-typing.
  useEffect(() => () => stopTyping(), [stopTyping])

  const active = Object.entries(typingPeers)
    .filter(([uid, info]) => uid !== selfUid && Date.now() - info.at < TYPING_TTL_MS)
    .map(([, info]) => info.name)

  // While anyone is typing, tick once a second so expired entries drop out even
  // if no new store update arrives.
  useEffect(() => {
    if (active.length === 0) return
    const id = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [active.length])

  let typingLabel: string | null = null
  if (active.length === 1) {
    typingLabel = t('team.someoneTyping').replace('{name}', active[0])
  } else if (active.length === 2) {
    typingLabel = t('team.twoTyping').replace('{a}', active[0]).replace('{b}', active[1])
  } else if (active.length > 2) {
    typingLabel = t('team.manyTyping').replace('{count}', String(active.length))
  }

  return { notifyTyping, stopTyping, typingLabel }
}
