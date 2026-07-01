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

  it('continues the original task when TMS.md is absent', async () => {
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

  it('does not build a bootstrap prompt for missing TMS.md', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('not found'))

    const result = await runTmsPreflight({
      projectPath: '/repo',
      originalUserMessageDisplayed: true,
      originalUserMessage: 'Implementar modal de NIF em /billing.',
    })
    const prompt = buildTmsBootstrapOnlyPrompt(result, 'Implementar modal de NIF em /billing.')

    expect(prompt).toBe('')
  })

  it('frames repair bootstrap as agent preflight, not as the user request', async () => {
    mockedInvoke.mockResolvedValueOnce('# TMS.md\n')

    const result = await runTmsPreflight({
      projectPath: '/repo',
      originalUserMessageDisplayed: true,
      originalUserMessage: 'Implementar modal de NIF em /billing.',
    })
    const prompt = buildTmsBootstrapOnlyPrompt(result, 'Implementar modal de NIF em /billing.')

    expect(result).toMatchObject({
      tmsFound: true,
      shouldBootstrap: true,
      reason: 'invalid',
    })
    expect(prompt).toContain('The user did NOT ask you to create TMS.md')
    expect(prompt).toContain('Original user request, pending for the next phase')
    expect(prompt).toContain('Implementar modal de NIF em /billing.')
    expect(prompt).toContain('TMS.md exists but is incomplete or invalid')
    expect(prompt).toContain('detected that an existing TMS.md needs repair')
    expect(prompt).toContain('First read and preserve the existing TMS.md')
    expect(prompt).toContain('If TMS.md already exists, read it first with Read')
    expect(prompt).not.toContain('TMS.md não encontrado')
    expect(prompt).not.toContain('TMS.md was not found')
    expect(prompt).not.toContain('project memory/map is missing')
    expect(prompt).not.toContain('TMS.md criado')
    expect(prompt).not.toContain('visão geral')
    expect(prompt).not.toContain('comandos')
    expect(prompt).not.toContain('padrões do projecto')
    expect(prompt).not.toContain('regras para o agente')
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
