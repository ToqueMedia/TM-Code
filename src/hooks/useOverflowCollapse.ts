import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Collision-based collapse — the honest version of "only collapse when elements
 * would actually collide", instead of a fixed CSS breakpoint.
 *
 * Observes `ref`'s element with a ResizeObserver and returns `collapsed = true`
 * when its content OVERFLOWS the available width (items are about to collide),
 * and `false` when there's room for the full layout again.
 *
 * The tricky part it solves: collapsing hides labels → the content shrinks →
 * naively it would look like it fits → expand → overflow → collapse … a flicker
 * loop. So while collapsed we DON'T trust the (now-smaller) scrollWidth; we
 * remember the natural (uncollapsed) width and only expand once the container is
 * wide enough for THAT again, plus a small margin (hysteresis).
 *
 * For overflow to be detectable, the observed element's children must not all
 * flex-shrink to nothing — keep the collapsible items `flexShrink={0}` (a single
 * flexible spacer is fine; it just hits 0 first, then real overflow begins).
 */
export function useOverflowCollapse(
  ref: RefObject<HTMLElement | null>,
  hysteresisPx = 12,
): boolean {
  const [collapsed, setCollapsed] = useState(false)
  const collapsedRef = useRef(false)
  const naturalWidthRef = useRef(0)
  collapsedRef.current = collapsed

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return // jsdom / unsupported

    const measure = () => {
      const available = el.clientWidth
      if (!collapsedRef.current) {
        // Expanded: content is at full width — record it, collapse if it overflows.
        naturalWidthRef.current = el.scrollWidth
        if (el.scrollWidth > available + 1) setCollapsed(true)
      } else if (available >= naturalWidthRef.current + hysteresisPx) {
        // Collapsed: only expand once there's room for the FULL layout again.
        setCollapsed(false)
      }
    }

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [ref, hysteresisPx])

  return collapsed
}
