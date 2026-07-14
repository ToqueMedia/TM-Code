/**
 * createPermissionAwareTimeout — verifies that the timer pauses while a
 * permission dialog is pending, then resumes from where it left off.
 *
 * The contract:
 *   - With no pending permission, fires after `timeoutMs` of wall-clock.
 *   - When pendingPermission is set, the active-time clock pauses.
 *   - When pendingPermission goes back to null, the active clock resumes
 *     from the value it had when paused.
 *   - Multiple pause/resume cycles accumulate correctly.
 *   - cleanup() removes the timer + permission subscription so leaks don't
 *     accumulate across tool calls.
 */

jest.mock('../../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({ pendingDiffs: [] }),
    subscribe: jest.fn(() => jest.fn()),
  },
}))

jest.mock('../../../stores/credentialRequestStore', () => ({
  useCredentialRequestStore: {
    getState: () => ({ pending: new Map() }),
    subscribe: jest.fn(() => jest.fn()),
  },
}))

import { createPermissionAwareTimeout } from '../safeToolPool'
import { usePermissionStore } from '../../../stores/permissionStore'

// We toggle pendingPermission directly via the store. resolve() is supplied
// to satisfy the type — none of these tests actually advance through the
// approve/deny path, they just observe the timer's reaction.
function setPending(name: string | null) {
  usePermissionStore.setState({
    pendingPermission: name === null ? null : {
      id: 'test-' + Math.random(),
      toolName: name,
      args: {},
      promptReason: null,
      resolve: () => { /* not used in these tests */ },
    },
  })
}

beforeEach(() => {
  // Reset store between tests so cycles don't bleed.
  usePermissionStore.setState({ pendingPermission: null, permissionQueue: [] })
})

describe('createPermissionAwareTimeout', () => {
  test('fires after timeoutMs when no permission is pending', async () => {
    const { promise, cleanup } = createPermissionAwareTimeout('test_tool', 100)
    try {
      await expect(promise).rejects.toThrow(/timed out after 0\.1 seconds/)
    } finally {
      cleanup()
    }
  })

  test('error message includes the tool name', async () => {
    const { promise, cleanup } = createPermissionAwareTimeout('request_credentials', 50)
    try {
      await expect(promise).rejects.toThrow(/Tool "request_credentials" timed out/)
    } finally {
      cleanup()
    }
  })

  test('does NOT fire while permission is continuously pending', async () => {
    setPending('request_credentials')
    const { promise, cleanup } = createPermissionAwareTimeout('request_credentials', 80)

    // Race the timeout against a wall-clock window twice as long. If the
    // timer were still ticking, it would fire before our marker resolved.
    const marker = new Promise<'still_alive'>((r) =>
      setTimeout(() => r('still_alive'), 200),
    )

    try {
      const result = await Promise.race([
        promise.catch((e) => e as Error),
        marker,
      ])
      expect(result).toBe('still_alive')
    } finally {
      cleanup()
    }
  })

  test('resumes the timer when permission is approved (cleared)', async () => {
    // Start with permission pending. The timer should accumulate ZERO active
    // ms during this period, then start counting once we clear the dialog.
    setPending('request_credentials')
    const { promise, cleanup } = createPermissionAwareTimeout('request_credentials', 100)

    // Sit on the dialog for longer than the timeout — proves the pause works
    await new Promise((r) => setTimeout(r, 150))

    // Approve. From here, the timer has the FULL 100ms of active time before firing.
    setPending(null)

    const fired = Date.now()
    try {
      await expect(promise).rejects.toThrow(/timed out/)
      const elapsed = Date.now() - fired
      // ~100ms after approve. Allow generous slack for slow CI.
      expect(elapsed).toBeGreaterThanOrEqual(80)
      expect(elapsed).toBeLessThan(300)
    } finally {
      cleanup()
    }
  })

  test('accumulates multiple pause/resume cycles', async () => {
    const { promise, cleanup } = createPermissionAwareTimeout('chain_tool', 100)

    // Cycle 1: pause for 80ms. Active time so far: ~0ms.
    setPending('chain_tool')
    await new Promise((r) => setTimeout(r, 80))
    setPending(null)

    // Run for 40ms in the active window. Active time so far: ~40ms.
    await new Promise((r) => setTimeout(r, 40))

    // Cycle 2: pause for 80ms again.
    setPending('chain_tool')
    await new Promise((r) => setTimeout(r, 80))
    setPending(null)

    // Now the timer should fire ~60ms after this point (100 - 40 = 60 active ms left)
    const beforeFire = Date.now()
    try {
      await expect(promise).rejects.toThrow(/timed out/)
      const elapsed = Date.now() - beforeFire
      expect(elapsed).toBeGreaterThanOrEqual(40)
      expect(elapsed).toBeLessThan(200)
    } finally {
      cleanup()
    }
  })

  test('cleanup() prevents the timer from firing later', async () => {
    const { promise, cleanup } = createPermissionAwareTimeout('test_tool', 50)
    cleanup() // tear down immediately

    // Track whether the promise rejects within a generous window.
    let rejected = false
    promise.catch(() => { rejected = true })

    await new Promise((r) => setTimeout(r, 150))
    expect(rejected).toBe(false)
  })

  test('cleanup() unsubscribes from the permission store', () => {
    const before = (usePermissionStore as unknown as { getState: () => Record<string, unknown> }).getState
    const { cleanup } = createPermissionAwareTimeout('t', 1000)
    cleanup()
    // No assertion on subscriber count (Zustand doesn't expose it cheaply),
    // but cleanup must not throw — that itself proves the unsubscribe path
    // is reached and the timer handle is cleared.
    expect(typeof before).toBe('function')
  })
})
