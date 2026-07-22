jest.mock('../commands/initCommand', () => ({ executeInit: jest.fn() }))
jest.mock('../commands/planCommand', () => ({ executePlan: jest.fn() }))
jest.mock('../commands/debugCommand', () => ({ executeDebug: jest.fn() }))
jest.mock('../commands/paymentsCommand', () => ({ executePayments: jest.fn() }))
jest.mock('../commands/e2eCommand', () => ({ executeE2E: jest.fn() }))
jest.mock('../commands/reviewCommand', () => ({ executeReview: jest.fn() }))
jest.mock('../commands/compactCommand', () => ({ executeCompact: jest.fn() }))

import { isSlashCommandAllowedForPlan, slashCommandRegistry } from '../slashCommandRegistry'
import type { UserPlanName } from '../../../stores/billingStore'

describe('slashCommandRegistry plan gates', () => {
  // /speed foi RETIRADO da UI em 2026-07-16 (código morto deliberado — ver o
  // bloco comentado em registerDefaults). Este teste fixa a retirada: se
  // alguém reativar o comando sem decisão explícita, isto rebenta.
  it('/speed is retired — not registered, not listed', () => {
    expect(slashCommandRegistry.getCommand('/speed')).toBeNull()
    expect(slashCommandRegistry.isSlashCommand('/speed on')).toBe(false)
    expect(slashCommandRegistry.listCommands().map(c => c.name)).not.toContain('/speed')
  })

  it('/te2e stays gated to paid plans', () => {
    const te2e = slashCommandRegistry.getCommand('/te2e')
    expect(te2e).toBeDefined()
    expect(te2e?.requiresPaidPlan).toBe(true)

    const allowedByPlan = (['explorer', 'vibe', 'pro', 'max', 'welcome', 'byok-only'] as UserPlanName[])
      .map(plan => [plan, isSlashCommandAllowedForPlan(te2e!, plan)])

    expect(allowedByPlan).toEqual([
      ['explorer', false],
      ['vibe', true],
      ['pro', true],
      ['max', true],
      ['welcome', true],
      ['byok-only', true],
    ])
  })
})
