/**
 * QueryGuard tests — covers the 3-state machine, generation counter,
 * and the race condition that motivated the port from Claude Code.
 */

import { QueryGuard } from '../queryGuard'

describe('QueryGuard', () => {
  describe('initial state', () => {
    it('starts idle (isActive=false, generation=0)', () => {
      const g = new QueryGuard()
      expect(g.isActive).toBe(false)
      expect(g.generation).toBe(0)
      expect(g.getSnapshot()).toBe(false)
    })
  })

  describe('reserve / cancelReservation (idle ↔ dispatching)', () => {
    it('reserve transitions idle → dispatching, isActive becomes true', () => {
      const g = new QueryGuard()
      expect(g.reserve()).toBe(true)
      expect(g.isActive).toBe(true)
      expect(g.getSnapshot()).toBe(true)
    })

    it('reserve returns false when not idle', () => {
      const g = new QueryGuard()
      g.reserve()
      expect(g.reserve()).toBe(false)
    })

    it('cancelReservation returns to idle from dispatching', () => {
      const g = new QueryGuard()
      g.reserve()
      g.cancelReservation()
      expect(g.isActive).toBe(false)
    })

    it('cancelReservation is a no-op when not dispatching', () => {
      const g = new QueryGuard()
      g.cancelReservation() // idle, should not change anything
      expect(g.isActive).toBe(false)
      expect(g.generation).toBe(0)
    })

    it('cancelReservation does NOT bump generation', () => {
      const g = new QueryGuard()
      g.reserve()
      g.cancelReservation()
      expect(g.generation).toBe(0)
    })
  })

  describe('tryStart (→ running)', () => {
    it('tryStart from idle transitions to running and returns generation 1', () => {
      const g = new QueryGuard()
      const gen = g.tryStart()
      expect(gen).toBe(1)
      expect(g.isActive).toBe(true)
      expect(g.generation).toBe(1)
    })

    it('tryStart from dispatching transitions to running', () => {
      const g = new QueryGuard()
      g.reserve()
      const gen = g.tryStart()
      expect(gen).toBe(1)
      expect(g.isActive).toBe(true)
    })

    it('tryStart returns null when already running', () => {
      const g = new QueryGuard()
      g.tryStart()
      expect(g.tryStart()).toBeNull()
    })

    it('each tryStart increments generation', () => {
      const g = new QueryGuard()
      const gen1 = g.tryStart()
      g.end(gen1!)
      const gen2 = g.tryStart()
      expect(gen2).toBe(2)
    })
  })

  describe('end (running → idle)', () => {
    it('end with current generation returns true and transitions to idle', () => {
      const g = new QueryGuard()
      const gen = g.tryStart()!
      expect(g.end(gen)).toBe(true)
      expect(g.isActive).toBe(false)
    })

    it('end with stale generation returns false and does NOT change state', () => {
      const g = new QueryGuard()
      const staleGen = g.tryStart()!
      g.forceEnd() // bumps gen to 2
      const newGen = g.tryStart()! // gen=3, running
      expect(g.end(staleGen)).toBe(false) // staleGen is 1, current is 3
      expect(g.isActive).toBe(true) // still running
      expect(g.generation).toBe(newGen)
    })

    it('end is a no-op if not in running state', () => {
      const g = new QueryGuard()
      const gen = g.tryStart()!
      g.end(gen) // idle now
      expect(g.end(gen)).toBe(false)
    })
  })

  describe('forceEnd', () => {
    it('forceEnd from running transitions to idle and bumps generation', () => {
      const g = new QueryGuard()
      const gen1 = g.tryStart()!
      g.forceEnd()
      expect(g.isActive).toBe(false)
      expect(g.generation).toBe(gen1 + 1)
    })

    it('forceEnd from dispatching also resets and bumps generation', () => {
      // Anti-ressurreição (Bloco A item 2, 2026-07-17): Stop durante a prep
      // do agentRunner (status ainda `dispatching` — tryStart ainda não correu)
      // TEM de avançar a generation. O runner captura generation no topo e
      // recusa arrancar se mudou; sem o bump, o zombie passava a guarda e
      // re-fazia tryStart (guard preso, fila eterna, tips a correr).
      const g = new QueryGuard()
      const genBefore = g.generation
      g.reserve()
      g.forceEnd()
      expect(g.isActive).toBe(false)
      expect(g.generation).toBe(genBefore + 1)
    })

    it('forceEnd from idle is a no-op', () => {
      const g = new QueryGuard()
      g.forceEnd()
      expect(g.isActive).toBe(false)
      expect(g.generation).toBe(0)
    })

    it('dispatchGeneration epoch detects Stop during dispatching prep', () => {
      // Modelo do contrato agentRunner + agentService: capturar generation no
      // início do dispatch; se forceEnd intermédio a avançar, o loop NÃO arranca.
      const g = new QueryGuard()
      g.reserve() // chat path: executeQueuedInput
      const dispatchGeneration = g.generation
      g.forceEnd() // stopAgentRun → cancelLoop durante prep
      expect(g.generation).not.toBe(dispatchGeneration)
      expect(g.isActive).toBe(false)
      // Novo envio pode reservar de imediato — fila não fica eterna
      expect(g.reserve()).toBe(true)
      const gen = g.tryStart()
      expect(gen).not.toBeNull()
      expect(g.isActive).toBe(true)
    })
  })

  describe('the cancel/restart race that the generation counter fixes', () => {
    it('a stale finally from a cancelled query does NOT reset a fresh query', () => {
      const g = new QueryGuard()

      // Loop A starts
      const genA = g.tryStart()!
      expect(genA).toBe(1)

      // User presses Stop → forceEnd bumps generation
      g.forceEnd()
      expect(g.generation).toBe(2)
      expect(g.isActive).toBe(false)

      // Loop B starts immediately
      const genB = g.tryStart()!
      expect(genB).toBe(3)
      expect(g.isActive).toBe(true)

      // Loop A's stale finally fires late — must NOT reset Loop B
      const result = g.end(genA)
      expect(result).toBe(false)
      expect(g.isActive).toBe(true) // Loop B still running
      expect(g.generation).toBe(3)
    })
  })

  describe('subscribe / signal', () => {
    it('subscribers are notified on every state change', () => {
      const g = new QueryGuard()
      const listener = jest.fn()
      g.subscribe(listener)

      g.reserve()
      expect(listener).toHaveBeenCalledTimes(1)

      g.tryStart()
      expect(listener).toHaveBeenCalledTimes(2)

      g.end(g.generation)
      expect(listener).toHaveBeenCalledTimes(3)
    })

    it('unsubscribe stops notifications', () => {
      const g = new QueryGuard()
      const listener = jest.fn()
      const unsubscribe = g.subscribe(listener)

      g.tryStart()
      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()
      g.forceEnd()
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('reserve does NOT notify if guard is already non-idle', () => {
      const g = new QueryGuard()
      g.tryStart()
      const listener = jest.fn()
      g.subscribe(listener)
      g.reserve() // returns false, should not notify
      expect(listener).not.toHaveBeenCalled()
    })
  })
})
