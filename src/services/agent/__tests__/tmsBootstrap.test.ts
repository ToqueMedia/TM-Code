import { invoke } from '@/utils/invokeMetrics'
import {
  buildTmsBootstrapOnlyPrompt,
  getTmsBootstrapCompleteMessageKey,
  getTmsBootstrapStartMessageKey,
  runTmsPreflight,
} from '../tmsBootstrap'
import { getTmsTurnTelemetry } from '../tmsContext'

jest.mock('@/utils/invokeMetrics', () => ({
  invoke: jest.fn(),
}))

const mockedInvoke = invoke as jest.Mock

const VALID_TMS = [
  '# TMS.md',
  '## visão geral',
  '## stack',
  '## comandos',
  '## estrutura',
  '## entrypoints',
  '## padrões do projecto',
  '## regras para o agente',
  '## confirmed',
  '## inferred',
  '## pending confirmation',
  '## lastGeneratedAt',
  '2026-06-29T00:00:00.000Z',
  '## sourceFilesUsed',
].join('\n')

describe('runTmsPreflight', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('never bootstraps when TMS.md is absent (claude-vaz parity: /init is the only creation path)', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('not found'))

    const result = await runTmsPreflight({
      projectPath: '/repo',
      originalUserMessageDisplayed: true,
    })
    const telemetry = getTmsTurnTelemetry()

    expect(result).toMatchObject({
      tmsFound: false,
      shouldBootstrap: false,
      reason: 'missing',
      path: '/repo/TMS.md',
    })
    expect(telemetry).toMatchObject({
      executionPhase: 'original_task',
      tmsFoundAtStart: false,
      tmsAvailable: false,
      tmsBootstrapTriggered: false,
      tmsBootstrapPhase: 'missing_skipped',
      originalUserMessageDisplayed: true,
      originalTaskResumedAfterBootstrap: false,
    })
  })

  it('builds no bootstrap prompt for missing TMS.md (the user message is never hijacked)', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('not found'))

    const result = await runTmsPreflight({
      projectPath: '/repo',
      originalUserMessageDisplayed: true,
      originalUserMessage: 'Implementar modal de NIF em /billing.',
    })
    const prompt = buildTmsBootstrapOnlyPrompt(result, 'Implementar modal de NIF em /billing.')

    expect(prompt).toBe('')
  })

  it('does not auto-repair an existing invalid TMS.md during normal preflight', async () => {
    mockedInvoke.mockResolvedValueOnce('# TMS.md\n')

    const result = await runTmsPreflight({
      projectPath: '/repo',
      originalUserMessageDisplayed: true,
      originalUserMessage: 'Implementar modal de NIF em /billing.',
    })
    const prompt = buildTmsBootstrapOnlyPrompt(result, 'Implementar modal de NIF em /billing.')

    expect(result).toMatchObject({
      tmsFound: true,
      shouldBootstrap: false,
      reason: 'invalid',
    })
    expect(prompt).toBe('')
    expect(getTmsTurnTelemetry()).toMatchObject({
      executionPhase: 'original_task',
      tmsBootstrapTriggered: false,
      tmsBootstrapPhase: 'already_exists_invalid',
      tmsAlreadyExists: true,
      tmsAvailable: true,
    })
  })

  it('does not auto-refresh an existing stale TMS.md during normal preflight', async () => {
    const staleTms = [
      VALID_TMS,
      '- src/app.ts',
    ].join('\n')
    mockedInvoke
      .mockResolvedValueOnce(staleTms)
      .mockResolvedValueOnce({ modifiedMs: Date.parse('2026-06-30T00:00:00.000Z') })

    const result = await runTmsPreflight({
      projectPath: '/repo',
      originalUserMessageDisplayed: true,
      originalUserMessage: 'Corrigir bug no login.',
    })

    expect(result).toMatchObject({
      tmsFound: true,
      valid: true,
      stale: true,
      shouldBootstrap: false,
      reason: 'stale',
    })
    expect(buildTmsBootstrapOnlyPrompt(result, 'Corrigir bug no login.')).toBe('')
    expect(getTmsTurnTelemetry()).toMatchObject({
      executionPhase: 'original_task',
      tmsBootstrapTriggered: false,
      tmsBootstrapPhase: 'already_exists_stale',
      tmsAlreadyExists: true,
      tmsAvailable: true,
    })
  })

  it('marks original_task directly when a valid TMS.md already exists', async () => {
    mockedInvoke.mockResolvedValueOnce(VALID_TMS)

    const result = await runTmsPreflight({
      projectPath: '/repo',
      originalUserMessageDisplayed: true,
    })
    const telemetry = getTmsTurnTelemetry()

    expect(result).toMatchObject({
      tmsFound: true,
      valid: true,
      shouldBootstrap: false,
      reason: 'ok',
    })
    expect(telemetry).toMatchObject({
      executionPhase: 'original_task',
      bootstrapCompleted: true,
      tmsFoundAtStart: true,
      tmsAvailable: true,
      tmsAvailableAfterBootstrap: true,
      tmsBootstrapCompleted: true,
      tmsAlreadyExists: true,
      tmsBootstrapTriggered: false,
    })
  })

  it('uses reason-specific localized message keys', async () => {
    mockedInvoke.mockResolvedValueOnce('# TMS.md\n')

    const repair = await runTmsPreflight({
      projectPath: '/repo',
      originalUserMessageDisplayed: true,
    })

    expect(getTmsBootstrapStartMessageKey({
      tmsFound: false,
      valid: false,
      stale: false,
      created: false,
      path: '/repo/TMS.md',
      shouldBootstrap: true,
      reason: 'missing',
    })).toBe('common.tmsBootstrapMissingStart')
    expect(getTmsBootstrapStartMessageKey(repair)).toBe('common.tmsBootstrapRepairStart')
    expect(getTmsBootstrapStartMessageKey({
      ...repair,
      stale: true,
      reason: 'stale',
    })).toBe('common.tmsBootstrapStaleStart')
    expect(getTmsBootstrapCompleteMessageKey(true)).toBe('common.tmsBootstrapCreatedComplete')
    expect(getTmsBootstrapCompleteMessageKey(false)).toBe('common.tmsBootstrapUpdatedComplete')
  })
})
