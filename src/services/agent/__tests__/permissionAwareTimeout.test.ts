/**
 * createPermissionAwareTimeout — verifies that the timer pauses while a
 * human gate is open, then resumes from where it left off.
 *
 * P4 (2026-08-03): o driver deixou de ser o permissionStore — a fonte de
 * "há humano a decidir?" é o contador de gates do hostBus, aberto pelo
 * host-janela à volta de cada via de decisão humana do AgentHost. Os
 * testes conduzem os gates directamente (beginHumanGate/end), que é
 * exactamente o que o windowHost faz.
 *
 * The contract:
 *   - With no open gate, fires after `timeoutMs` of wall-clock.
 *   - While a gate is open, the active-time clock pauses.
 *   - When the gate closes, the active clock resumes from the value it had
 *     when paused.
 *   - Multiple pause/resume cycles accumulate correctly.
 *   - cleanup() removes the timer + gate subscription so leaks don't
 *     accumulate across tool calls.
 */

import { createPermissionAwareTimeout } from '../toolExecutor/permissionAwareTimeout'
import { beginHumanGate } from '../host/hostBus'

let endGate: (() => void) | null = null

/** Abre/fecha um gate humano — o equivalente ao diálogo pendente de antes. */
function setPending(open: boolean) {
  if (open) {
    endGate = beginHumanGate()
  } else {
    endGate?.()
    endGate = null
  }
}

afterEach(() => {
  // Fecha qualquer gate deixado aberto para os ciclos não sangrarem.
  endGate?.()
  endGate = null
})

describe('createPermissionAwareTimeout', () => {
  test('fires after timeoutMs when no gate is open', async () => {
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

  test('does NOT fire while a gate stays open', async () => {
    setPending(true)
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

  test('resumes the timer when the gate closes (approval)', async () => {
    // Start with a gate open. The timer should accumulate ZERO active ms
    // during this period, then start counting once the gate closes.
    setPending(true)
    const { promise, cleanup } = createPermissionAwareTimeout('request_credentials', 100)

    // Sit on the dialog for longer than the timeout — proves the pause works
    await new Promise((r) => setTimeout(r, 150))

    // Approve. From here, the timer has the FULL 100ms of active time before firing.
    setPending(false)

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
    setPending(true)
    await new Promise((r) => setTimeout(r, 80))
    setPending(false)

    // Run for 40ms in the active window. Active time so far: ~40ms.
    await new Promise((r) => setTimeout(r, 40))

    // Cycle 2: pause for 80ms again.
    setPending(true)
    await new Promise((r) => setTimeout(r, 80))
    setPending(false)

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

  test('sobreposição de gates: só fecha a pausa quando TODOS fecham', async () => {
    const { promise, cleanup } = createPermissionAwareTimeout('overlap_tool', 100)

    // Dois gates em simultâneo (ex.: permissão + diff em lote) — fechar o
    // primeiro não pode retomar o relógio enquanto o segundo está aberto.
    const endA = beginHumanGate()
    const endB = beginHumanGate()
    await new Promise((r) => setTimeout(r, 80))
    endA()
    await new Promise((r) => setTimeout(r, 80))
    endB()

    const beforeFire = Date.now()
    try {
      await expect(promise).rejects.toThrow(/timed out/)
      const elapsed = Date.now() - beforeFire
      expect(elapsed).toBeGreaterThanOrEqual(80)
      expect(elapsed).toBeLessThan(300)
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

  test('cleanup() unsubscribes from the gate channel', async () => {
    const { promise, cleanup } = createPermissionAwareTimeout('t', 60)
    cleanup()
    let rejected = false
    promise.catch(() => { rejected = true })
    // Transições de gate depois do cleanup não podem ressuscitar o timer.
    setPending(true)
    setPending(false)
    await new Promise((r) => setTimeout(r, 120))
    expect(rejected).toBe(false)
  })
})
