jest.mock('../commands/initCommand', () => ({ executeInit: jest.fn() }))
jest.mock('../commands/planCommand', () => ({ executePlan: jest.fn() }))
jest.mock('../commands/debugCommand', () => ({ executeDebug: jest.fn() }))
jest.mock('../commands/paymentsCommand', () => ({ executePayments: jest.fn() }))
jest.mock('../commands/e2eCommand', () => ({ executeE2E: jest.fn() }))
jest.mock('../commands/reviewCommand', () => ({ executeReview: jest.fn() }))
jest.mock('../commands/compactCommand', () => ({ executeCompact: jest.fn() }))
jest.mock('../commands/speedCommand', () => ({ executeSpeed: jest.fn() }))

import { isSlashCommandAllowedForPlan, slashCommandRegistry } from '../slashCommandRegistry'
import type { UserPlanName } from '../../../stores/billingStore'

describe('slashCommandRegistry plan gates', () => {
  it('/speed is available only on Pro and Max', () => {
    const speed = slashCommandRegistry.getCommand('/speed')
    expect(speed).toBeDefined()
    expect(speed?.allowedPlans).toEqual(['pro', 'max'])

    const allowedByPlan = (['explorer', 'vibe', 'pro', 'max', 'welcome', 'byok-only'] as UserPlanName[])
      .map(plan => [plan, isSlashCommandAllowedForPlan(speed!, plan)])

    expect(allowedByPlan).toEqual([
      ['explorer', false],
      ['vibe', false],
      ['pro', true],
      ['max', true],
      ['welcome', false],
      ['byok-only', false],
    ])
  })
})
