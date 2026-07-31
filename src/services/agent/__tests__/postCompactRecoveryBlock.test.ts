/**
 * buildPostCompactRecoveryBlock — o material que volta ao contexto depois de uma
 * compactação (paridade com os anexos pós-compactação do claude-vaz).
 *
 * O teto global é a parte não óbvia: os tectos por parte somam ~140K caracteres,
 * injetados logo a seguir a uma compactação que existiu precisamente para
 * libertar espaço. Sem o teto, a recuperação podia voltar a cruzar o limiar e
 * disparar outra compactação no turno seguinte — um ciclo que o utilizador vê
 * como "está sempre a comprimir".
 */
import { SessionState } from '../sessionState'
import { POST_COMPACTION_RECOVERY_MAX_CHARS } from '../agentConfig'

const mockInvoke = jest.fn()
const mockSkillsBlock = jest.fn<string | null, []>()

jest.mock('../../../utils/invokeMetrics', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))
jest.mock('../diffService', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getPendingDiffs: () => [] }) },
}))
jest.mock('../skillService', () => ({
  buildPostCompactionSkillsBlock: () => mockSkillsBlock(),
}))
jest.mock('../toolExecutor/readRangeTracker', () => ({
  getReadRanges: () => [],
}))

import { buildPostCompactRecoveryBlock } from '../contextManager'

function stateWithFiles(paths: string[]): SessionState {
  const state = new SessionState(200_000)
  for (const path of paths) state.trackFileAccess('read_file', { path })
  return state
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockSkillsBlock.mockReset()
  mockSkillsBlock.mockReturnValue(null)
})

describe('buildPostCompactRecoveryBlock', () => {
  it('nada acedido e nada a registar → null (não injeta cabeçalhos vazios)', async () => {
    expect(await buildPostCompactRecoveryBlock(new SessionState(200_000))).toBeNull()
  })

  it('relê os ficheiros acedidos e devolve o conteúdo ATUAL do disco', async () => {
    mockInvoke.mockResolvedValue('conteúdo fresco')
    const block = await buildPostCompactRecoveryBlock(stateWithFiles(['/p/a.ts']))
    // O ponto todo é ser o conteúdo de agora: o do tool result compactado podia
    // já estar desatualizado pelas edições que se seguiram.
    expect(block).toContain('conteúdo fresco')
    expect(block).toContain('/p/a.ts')
  })

  it('um ficheiro apagado não derruba a recuperação dos outros', async () => {
    mockInvoke.mockImplementation((_cmd: string, args: { path: string }) =>
      args.path === '/p/ido.ts'
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve('vivo'),
    )
    const block = await buildPostCompactRecoveryBlock(stateWithFiles(['/p/ido.ts', '/p/ok.ts']))
    expect(block).toContain('vivo')
    expect(block).not.toContain('/p/ido.ts')
  })

  it('skills primeiro: são regras, e perdê-las não faz o modelo reler — faz escrever contra o prior', async () => {
    mockSkillsBlock.mockReturnValue('<post_compaction_skills>REGRAS</post_compaction_skills>')
    mockInvoke.mockResolvedValue('ficheiro')
    const block = await buildPostCompactRecoveryBlock(stateWithFiles(['/p/a.ts']), 'ops log')
    expect(block!.indexOf('REGRAS')).toBeLessThan(block!.indexOf('ficheiro'))
    expect(block!.indexOf('ficheiro')).toBeLessThan(block!.indexOf('ops log'))
  })

  it('teto global corta as partes de menor valor e DIZ quantas ficaram de fora', async () => {
    mockSkillsBlock.mockReturnValue('S'.repeat(POST_COMPACTION_RECOVERY_MAX_CHARS))
    mockInvoke.mockResolvedValue('conteudo-de-ficheiro')
    const block = await buildPostCompactRecoveryBlock(stateWithFiles(['/p/a.ts']), 'ops log')

    expect(block).toContain('S'.repeat(100))
    expect(block).not.toContain('conteudo-de-ficheiro')
    // Cortar em silêncio lê-se como "isto é tudo o que havia".
    expect(block).toContain('2 further recovery section(s) omitted')
  })

  it('a primeira parte entra mesmo que sozinha exceda o teto (senão o teto esvaziava tudo)', async () => {
    mockSkillsBlock.mockReturnValue('S'.repeat(POST_COMPACTION_RECOVERY_MAX_CHARS * 2))
    const block = await buildPostCompactRecoveryBlock(new SessionState(200_000), 'ops')
    expect(block).not.toBeNull()
    expect(block!.length).toBeGreaterThan(POST_COMPACTION_RECOVERY_MAX_CHARS)
  })

  it('dentro do teto não anuncia cortes nenhuns', async () => {
    mockSkillsBlock.mockReturnValue('REGRAS')
    mockInvoke.mockResolvedValue('ficheiro')
    const block = await buildPostCompactRecoveryBlock(stateWithFiles(['/p/a.ts']), 'ops')
    expect(block).not.toContain('omitted to stay within')
  })

  it('não repete a memória de sessão — essa é secção dinâmica do system prompt', async () => {
    mockInvoke.mockResolvedValue('ficheiro')
    const block = await buildPostCompactRecoveryBlock(stateWithFiles(['/p/a.ts']))
    // Repeti-la aqui era pagá-la duas vezes no mesmo pedido.
    expect(block).not.toContain('Session memory')
  })
})
