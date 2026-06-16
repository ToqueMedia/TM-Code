/**
 * GoalCelebration overlay — verifies the skip-first-token logic and the
 * self-clearing burst. Uses the low-level react-dom harness (createRoot + act)
 * rather than @testing-library/react: this repo doesn't install
 * `@testing-library/dom`, so RTL can't resolve (same reason ChatView.error185
 * uses this pattern). Exercises the reduced-motion path so the assertion is
 * deterministic — no framer-motion tween runs in jsdom.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import { theme } from '@/theme'
import { GoalCelebration } from '../GoalCelebration'
import { useCelebrationStore } from '@/stores/celebrationStore'

// jsdom lacks structuredClone (Chakra clones its theme config on mount).
globalThis.structuredClone =
  globalThis.structuredClone ||
  (<T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)))

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
})

function setReducedMotion(reduced: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: reduced,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }),
  })
}

// Matches the goal word in either locale: GOOOAL! (en) / GOOOLO! (pt).
const GOAL_RE = /GOO+(?:AL|LO)!/

let container: HTMLDivElement
let root: Root

function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <ChakraProvider value={theme}>
        <GoalCelebration />
      </ChakraProvider>,
    )
  })
}

describe('GoalCelebration', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    useCelebrationStore.setState({ goalToken: 0, lastReason: null })
    // Force the deterministic reduced-motion path.
    setReducedMotion(true)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    jest.useRealTimers()
  })

  it('renders nothing until a goal is scored after mount', () => {
    mount()
    expect(container.textContent || '').not.toMatch(GOAL_RE)
  })

  it('plays a burst when the token increments, then clears itself', () => {
    mount()

    act(() => {
      useCelebrationStore.getState().celebrateGoal('test')
    })
    expect(container.textContent || '').toMatch(GOAL_RE)

    // Reduced-motion hold is 1200ms — past it the overlay clears.
    act(() => {
      jest.advanceTimersByTime(1300)
    })
    expect(container.textContent || '').not.toMatch(GOAL_RE)
  })
})
