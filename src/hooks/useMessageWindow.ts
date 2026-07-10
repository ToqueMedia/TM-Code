import { useCallback, useEffect, useRef, useState } from 'react'

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
 *     ChatView for the wiring).
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
  options: { resetKey?: string | null; pageSize?: number; collapseThreshold?: number } = {},
): UseMessageWindowResult<T> {
  const { resetKey, pageSize = 30, collapseThreshold = 10 } = options

  // SINGLE source of truth. The previous version split this across two effects
  // (a "reset on resetKey/length" effect and a "grow as messages arrive"
  // effect) that wrote the same two pieces of state. They FOUGHT each other:
  // because the reset effect also depended on `items.length`, every appended
  // message re-fired it, snapping the window back to `pageSize` while the
  // growth effect pushed it back up — in the same commit. With pageSize=2
  // (ChatView) the visible symptoms were the streaming "tremble": a conflicting
  // double setState (extra render) per message, the visible window re-slicing
  // so bubbles swapped places, the window pinned at ~3 items (older turns
  // dropping in/out of the DOM), the user's own loadMore() getting undone by
  // the next message, and a churning top sentinel that mis-fired the
  // IntersectionObserver into a scroll-restore fight with useStickToBottom.
  //
  // Collapsing to one state object + one effect makes the transitions
  // mutually exclusive and stale-closure-proof (functional updater):
  //   • resetKey changed        → fresh window at the bottom (session switch)
  //   • length grew, same session→ keep new messages visible (visibleCount += Δ)
  //   • length shrank (compaction)→ re-anchor only; clamp handles the count
  // `anchor` is the item count the visibleCount was last reconciled against.
  const [state, setState] = useState<{ anchor: number; visibleCount: number }>(() => {
    const total = items.length
    return { anchor: total, visibleCount: total <= collapseThreshold ? total : pageSize }
  })
  const prevResetKeyRef = useRef(resetKey)

  useEffect(() => {
    const total = items.length
    setState(prev => {
      // Session / project switch → start the new conversation at the bottom
      // instead of inheriting the previous one's expanded window.
      if (prevResetKeyRef.current !== resetKey) {
        prevResetKeyRef.current = resetKey
        return { anchor: total, visibleCount: total <= collapseThreshold ? total : pageSize }
      }
      // Same session, more messages → grow so freshly-rendered turns stay in
      // view without the caller nudging anything.
      if (total > prev.anchor) {
        return { anchor: total, visibleCount: prev.visibleCount + (total - prev.anchor) }
      }
      // Same session, fewer messages (compaction/replace) → re-anchor; the
      // Math.min clamp below keeps the rendered slice valid.
      if (total < prev.anchor) {
        return { anchor: total, visibleCount: prev.visibleCount }
      }
      return prev
    })
  }, [resetKey, items.length, pageSize, collapseThreshold])

  const total = items.length
  const clampedCount = Math.min(state.visibleCount, total)
  const visibleItems = clampedCount >= total ? items : items.slice(total - clampedCount)
  const canLoadMore = clampedCount < total
  const hiddenCount = canLoadMore ? total - clampedCount : 0

  const loadMore = useCallback(() => {
    setState(prev => ({ ...prev, visibleCount: prev.visibleCount + pageSize }))
  }, [pageSize])

  return { visibleItems, canLoadMore, loadMore, hiddenCount }
}
