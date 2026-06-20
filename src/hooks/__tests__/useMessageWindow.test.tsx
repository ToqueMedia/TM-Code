/**
 * Regression coverage for the streaming "tremble". The window must GROW as
 * messages stream in (keeping new turns visible) and must never snap back to
 * `pageSize` on append — the old two-effect version did, which re-sliced the
 * visible list and undid the user's loadMore(). See the hook's header comment.
 *
 * Uses the same bare createRoot + act harness as ChatView.error185.test.tsx
 * (the project doesn't ship @testing-library/dom, so renderHook is unavailable).
 */
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useMessageWindow, type UseMessageWindowResult } from '../useMessageWindow'

// React 19 wants this flag set so act() doesn't warn about updates (e.g. the
// final unmount) outside a concurrent act scope.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const seq = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`)

let container: HTMLDivElement
let root: Root
let latest: UseMessageWindowResult<string>

interface HarnessProps {
  items: string[]
  rkey: string | null
  pageSize?: number
  threshold?: number
}

function Harness({ items, rkey, pageSize = 2, threshold = 10 }: HarnessProps) {
  latest = useMessageWindow(items, { resetKey: rkey, pageSize, collapseThreshold: threshold })
  return null
}

function render(props: HarnessProps) {
  act(() => {
    root.render(<Harness {...props} />)
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useMessageWindow', () => {
  it('opens at pageSize when the session is larger than the collapse threshold', () => {
    render({ items: seq(50), rkey: 's1' })
    expect(latest.visibleItems).toEqual(['m48', 'm49'])
    expect(latest.canLoadMore).toBe(true)
    expect(latest.hiddenCount).toBe(48)
  })

  it('shows everything when the session fits under the collapse threshold', () => {
    render({ items: seq(4), rkey: 's1' })
    expect(latest.visibleItems).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(latest.canLoadMore).toBe(false)
  })

  it('grows the window as messages are appended — never snaps back to pageSize', () => {
    render({ items: seq(50), rkey: 's1' })
    expect(latest.visibleItems).toHaveLength(2)

    render({ items: seq(51), rkey: 's1' })
    render({ items: seq(52), rkey: 's1' })
    render({ items: seq(53), rkey: 's1' })

    // 2 original + 3 appended, bottom-anchored.
    expect(latest.visibleItems).toEqual(['m48', 'm49', 'm50', 'm51', 'm52'])
  })

  it('keeps a loadMore() expansion across a subsequent append (the bug it regresses)', () => {
    render({ items: seq(50), rkey: 's1' })
    act(() => latest.loadMore()) // 2 → 4
    expect(latest.visibleItems).toHaveLength(4)

    // A new message arrives — the expansion must survive (old code reset to 2).
    render({ items: seq(51), rkey: 's1' })
    expect(latest.visibleItems).toHaveLength(5)
  })

  it('resets to the bottom on session switch (resetKey change)', () => {
    render({ items: seq(50), rkey: 's1' })
    act(() => latest.loadMore())
    expect(latest.visibleItems.length).toBeGreaterThan(2)

    render({ items: seq(80), rkey: 's2' })
    expect(latest.visibleItems).toEqual(['m78', 'm79'])
    expect(latest.canLoadMore).toBe(true)
  })

  it('re-anchors without breaking the slice when the array shrinks (compaction)', () => {
    render({ items: seq(50), rkey: 's1' })
    render({ items: seq(53), rkey: 's1' }) // grow first
    render({ items: seq(2), rkey: 's1' })  // compaction collapses to 2
    expect(latest.visibleItems).toEqual(['m0', 'm1'])
    expect(latest.canLoadMore).toBe(false)
  })
})
