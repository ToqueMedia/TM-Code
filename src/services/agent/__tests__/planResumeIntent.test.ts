import { classifyPendingPlanIntent } from '../planResumeIntent'

describe('classifyPendingPlanIntent', () => {
  it('routes ordinary follow-ups back to the architect', () => {
    expect(classifyPendingPlanIntent('prossegue')).toBe('architect')
    expect(classifyPendingPlanIntent('aplica isto e segue para a próxima parte')).toBe('architect')
    expect(classifyPendingPlanIntent('usa PostgreSQL em vez de SQLite')).toBe('architect')
    expect(classifyPendingPlanIntent('o que ficou por terminar?')).toBe('architect')
  })

  it('only cancels explicit short cancellation messages', () => {
    expect(classifyPendingPlanIntent('cancelar')).toBe('cancel')
    expect(classifyPendingPlanIntent('stop')).toBe('cancel')
    expect(classifyPendingPlanIntent('não')).toBe('cancel')
    expect(classifyPendingPlanIntent('não prosseguir')).toBe('cancel')
  })

  it('does not mistake requirement feedback for cancellation', () => {
    expect(classifyPendingPlanIntent('não uses sqlite, usa postgres')).toBe('architect')
    expect(classifyPendingPlanIntent('não avances para implementação; termina só o plano')).toBe('architect')
  })
})
