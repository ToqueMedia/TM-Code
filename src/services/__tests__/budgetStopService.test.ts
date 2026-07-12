/**
 * Watcher de paragem global por orçamento esgotado (budgetStopService).
 * Cada cenário re-require o módulo — o watcher guarda estado module-level
 * (started/handledExhaustion) e o billingStore real também é module-level.
 */

// Sem imports top-level (tudo via require nos setups), o ficheiro seria um
// SCRIPT de escopo global para o tsc e o `setup()` daqui colidia com o de
// outros testes no yarn build. `export {}` torna-o módulo.
export {}

const mockIsAgentRunning = jest.fn<boolean, []>(() => false)
const mockCancelLoop = jest.fn()
jest.mock('@/services/agent/agentService', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      isAgentRunning: mockIsAgentRunning,
      cancelLoop: mockCancelLoop,
    }),
  },
}))

const mockAbortAll = jest.fn()
const mockGetPendingCount = jest.fn<number, []>(() => 0)
jest.mock('@/stores/subAgentStore', () => ({
  useSubAgentStore: {
    getState: () => ({
      abortAll: mockAbortAll,
      getPendingCount: mockGetPendingCount,
    }),
  },
}))

const mockAddSystemMessage = jest.fn()
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({ addSystemMessage: mockAddSystemMessage }),
  },
}))

const mockMarkBudgetStop = jest.fn()
jest.mock('@/services/projectAgentStatusService', () => ({
  markNextStopAsBudgetStop: mockMarkBudgetStop,
}))

jest.mock('@/i18n', () => ({ t: (key: string) => key }))

jest.mock('@/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

type BillingStoreModule = typeof import('@/stores/billingStore')

function setup() {
  jest.resetModules()
  jest.clearAllMocks()
  const { useBillingStore } = require('@/stores/billingStore') as BillingStoreModule
  useBillingStore.getState().clearNoCredits()
  const service = require('../budgetStopService') as typeof import('../budgetStopService')
  service.initBudgetStopWatcher()
  return { useBillingStore }
}

/** stopAllAgentWork é async (dynamic imports) — dá-lhe os microtasks. */
async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('budgetStopService', () => {
  it('aborts everything and explains why when noCredits flips mid-run', async () => {
    const { useBillingStore } = setup()
    mockIsAgentRunning.mockReturnValue(true)

    useBillingStore.getState().setNoCredits()
    await flush()

    // Badge marcado ANTES do cancel (o cancel dispara a transição de estado
    // que o projectAgentStatusService traduz em badge).
    expect(mockMarkBudgetStop).toHaveBeenCalledWith('billing.budgetStopBadge')
    expect(mockAbortAll).toHaveBeenCalledTimes(1)
    expect(mockCancelLoop).toHaveBeenCalledTimes(1)
    expect(mockAddSystemMessage).toHaveBeenCalledTimes(1)
    expect(mockAddSystemMessage.mock.calls[0][0]).toContain('billing.budgetStopMessage')
    expect(mockAddSystemMessage.mock.calls[0][1]).toBe('error')
  })

  it('also fires when only sub-agents are running', async () => {
    const { useBillingStore } = setup()
    mockIsAgentRunning.mockReturnValue(false)
    mockGetPendingCount.mockReturnValue(2)

    useBillingStore.getState().setNoCredits()
    await flush()

    expect(mockAbortAll).toHaveBeenCalledTimes(1)
    expect(mockCancelLoop).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the agent is idle (pre-flight guard already covers new runs)', async () => {
    const { useBillingStore } = setup()
    mockIsAgentRunning.mockReturnValue(false)
    mockGetPendingCount.mockReturnValue(0)

    useBillingStore.getState().setNoCredits()
    await flush()

    expect(mockAbortAll).not.toHaveBeenCalled()
    expect(mockCancelLoop).not.toHaveBeenCalled()
    expect(mockAddSystemMessage).not.toHaveBeenCalled()
  })

  it('handles one episode once, and re-arms after credits come back', async () => {
    const { useBillingStore } = setup()
    mockIsAgentRunning.mockReturnValue(true)

    useBillingStore.getState().setNoCredits()
    await flush()
    // Repetição do mesmo episódio (ex.: segundo 402 concorrente) — sem flip
    // false→true, não re-dispara.
    useBillingStore.getState().setNoCredits()
    await flush()
    expect(mockCancelLoop).toHaveBeenCalledTimes(1)

    // Compra/reset → volta a armar.
    useBillingStore.getState().clearNoCredits()
    useBillingStore.getState().setNoCredits()
    await flush()
    expect(mockCancelLoop).toHaveBeenCalledTimes(2)
  })
})
