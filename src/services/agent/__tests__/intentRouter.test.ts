jest.mock('../../auth/firebaseAuth', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getIdToken: jest.fn().mockResolvedValue(null),
    }),
  },
  getAppCheckHeader: jest.fn().mockResolvedValue({}),
}))

jest.mock('../../../utils/devUrls', () => ({
  resolveAIWorkerUrl: () => 'http://worker.test',
}))

import { classifyIntent, hasExplicitNoEditIntent } from '../intentRouter'

describe('intentRouter local no-edit safety', () => {
  it('detects Portuguese no-edit instructions deterministically', () => {
    expect(hasExplicitNoEditIntent('Não editar nada')).toBe(true)
    expect(hasExplicitNoEditIntent('sem editar, apenas confirme')).toBe(true)
  })

  it('detects English no-edit instructions deterministically', () => {
    expect(hasExplicitNoEditIntent("don't edit, just inspect")).toBe(true)
    expect(hasExplicitNoEditIntent('read-only review')).toBe(true)
  })

  it('does not classify ordinary edit requests as no-edit', () => {
    expect(hasExplicitNoEditIntent('corrija o bug no editor')).toBe(false)
    expect(hasExplicitNoEditIntent('edit the failing test')).toBe(false)
  })

  it('forces read-only before auth/fetch can fail', async () => {
    const intent = await classifyIntent('Não editar nada')
    expect(intent).toMatchObject({
      profile: 'analysis_readonly',
      readOnly: true,
      source: 'keyword',
      confidence: 'high',
    })
  })
})
