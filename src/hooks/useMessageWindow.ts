import { useCallback, useEffect, useState } from 'react'

/**
 * Sliding-window pagination over a message array.
 *
 * Why we need it
 * --------------
 * The chat (`ChatView`, `ChatPanel`) and the terminal view used to render
 * `messages.map(...)` over the entire session array. Each `MessageBubble`
 * is a `memo()` component, but the render pass still walks every entry,
 * builds its props, and reconciles its sub-tree. Long sessions (a couple
 * of hundred turns with tool calls and code blocks) become noticeably slow
 * to scroll, switch into, and stream into — even when only the last few
 * messages are interactive.
 *
 * Behaviour
 * ---------
 *   - Initial render shows the LAST `pageSize` messages (default 30).
 *   - `loadMore()` adds another `pageSize` to the visible window, scrolling
 *     up the slice boundary toward index 0. Idempotent once the full array
 *     fits in the window (the `Math.min` clamp).
 *   - New messages appended at the bottom (the streaming case) stay
 *     visible automatically — the window measures from the END of the
 *     array, not from a fixed top index, so growth pushes content into
 *     view without the caller having to nudge `visibleCount`.
 *   - `resetKey` resets the window to the initial page. Pass the session
 *     id (or project path, terminal session id, etc.) so switching
 *     conversations starts the new one at the bottom instead of mid-
 *     scroll through the previous one's history.
 *
 * What it deliberately does NOT do
 * --------------------------------
 *   - Drop messages from the store. The full array stays in `ChatSession.
 *     messages` so context-builder, compaction, and persistence keep
 *     working unchanged. We slice at render time only.
 *   - Manage scroll position. The caller owns the scroll container and is
 *     in the best position to capture `scrollHeight` before the next
 *     paint and restore the relative offset after `loadMore` runs (see
 *     ChatView / TerminalView for the wiring).
 *   - Hook up the IntersectionObserver / scroll listener that decides
 *     WHEN to fire `loadMore`. That's a render-time concern (need a DOM
 *     element to observe) and lives in the consumer.
 */
export interface UseMessageWindowResult<T> {
  /** Last N items (oldest first → newest last). Suitable for `.map` directly. */
  visibleItems: T[]
  /** True when there are still earlier items beyond the window. */
  canLoadMore: boolean
  /** Expand the window by another `pageSize`. No-op when already full. */
  loadMore: () => void
  /** Number of items hidden above the window (handy for "Load N more" labels). */
  hiddenCount: number
}

export function useMessageWindow<T>(
  items: T[],
  options: { resetKey?: string | null; pageSize?: number } = {},
): UseMessageWindowResult<T> {
  const { resetKey, pageSize = 30 } = options
  const [visibleCount, setVisibleCount] = useState(pageSize)

  // Reset on session / project switch. Without this, opening a fresh
  // conversation would start somewhere mid-history if the previous one had
  // been scrolled up.
  useEffect(() => {
    setVisibleCount(pageSize)
  }, [resetKey, pageSize])

  const total = items.length
  const clampedCount = Math.min(visibleCount, total)
  const visibleItems = clampedCount >= total ? items : items.slice(total - clampedCount)
  const canLoadMore = clampedCount < total
  const hiddenCount = canLoadMore ? total - clampedCount : 0

  const loadMore = useCallback(() => {
    setVisibleCount((c) => c + pageSize)
  }, [pageSize])

  return { visibleItems, canLoadMore, loadMore, hiddenCount }
}
