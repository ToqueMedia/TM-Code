import { useCallback, useEffect, useRef, useState } from 'react'

interface Options {
  isStreaming: boolean
  streamingVersion: number
  messageCount: number
  /** Threshold in px to still be considered "at bottom". */
  threshold?: number
}

/**
 * Terminal-style scroll follow: sticks to bottom while the user is near the
 * bottom, pauses auto-follow when the user scrolls up, resumes when they
 * scroll back down within the threshold.
 */
export function useCmdScrollFollow({
  isStreaming,
  streamingVersion,
  messageCount,
  threshold = 24,
}: Options) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(true)
  const stuckRef = useRef(stuck)

  useEffect(() => { stuckRef.current = stuck }, [stuck])

  const isNearBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
  }, [threshold])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const stickToBottom = useCallback(() => {
    setStuck(true)
    requestAnimationFrame(scrollToBottom)
  }, [scrollToBottom])

  // Track user scroll intent.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const near = isNearBottom(el)
        if (near !== stuckRef.current) setStuck(near)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [isNearBottom])

  // Follow streaming deltas only while stuck.
  useEffect(() => {
    if (!isStreaming) return
    if (!stuckRef.current) return
    scrollToBottom()
  }, [streamingVersion, isStreaming, scrollToBottom])

  // New message added → stick again (sending a prompt is an intent to follow).
  useEffect(() => {
    stickToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageCount])

  // Final pass after streaming ends.
  useEffect(() => {
    if (isStreaming) return
    if (!stuckRef.current) return
    const t = setTimeout(scrollToBottom, 60)
    return () => clearTimeout(t)
  }, [isStreaming, scrollToBottom])

  return { scrollRef, stuck, stickToBottom }
}
