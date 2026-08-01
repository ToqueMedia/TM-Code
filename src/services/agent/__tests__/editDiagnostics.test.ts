/**
 * O valor deste guarda está na baseline: sem ela, um projeto com erros
 * pré-existentes entrega-os a cada edit e o modelo aprende a ignorar o aviso.
 *
 * A fonte é `tsc --noEmit` corrido pelo Rust (`execute_command`), mockado aqui:
 * o que se testa é a lógica de delta e o parser, não o type checker.
 */
const invokeMock = jest.fn()
jest.mock('@/utils/invokeMetrics', () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}))

import {
  startDiagnosticsBaseline,
  markProjectEdited,
  collectNewDiagnostics,
  formatDiagnosticsReminder,
  resetEditDiagnostics,
  parseTscOutput,
} from '../editDiagnostics'

const ROOT = '/p'
/** Resposta do `execute_command` com as linhas de erro dadas. */
const tsc = (...lines: string[]) => ({
  stdout: lines.join('\n'), stderr: '', exitCode: lines.length ? 2 : 0, success: !lines.length,
})
const E = (file: string, line: number, code: number, msg: string) =>
  `${file}(${line},5): error TS${code}: ${msg}`

const DANGLING = "Property 'seedStorefrontTemplate' does not exist on type 'ApiClient'."

describe('editDiagnostics', () => {
  beforeEach(() => {
    resetEditDiagnostics()
    invokeMock.mockReset()
  })

  describe('parseTscOutput', () => {
    it('lê o formato de --pretty false', () => {
      const out = parseTscOutput(
        "src/a.ts(240,17): error TS2339: Property 'x' does not exist on type 'Y'.\nlixo\n",
      )
      expect(out).toEqual([{
        file: 'src/a.ts', line: 240, column: 17, severity: 'error',
        code: 2339, message: "Property 'x' does not exist on type 'Y'.",
      }])
    })

    it('ignora ruído e sumários do tsc', () => {
      expect(parseTscOutput('Found 3 errors in 2 files.\n\n')).toEqual([])
    })
  })

  it('erros pré-existentes não são reportados', async () => {
    invokeMock
      .mockResolvedValueOnce(tsc(E('/p/a.ts', 10, 7006, "Parameter 'x' implicitly has an 'any' type.")))
      .mockResolvedValueOnce(tsc(E('/p/a.ts', 10, 7006, "Parameter 'x' implicitly has an 'any' type.")))
    await startDiagnosticsBaseline(ROOT)
    markProjectEdited()
    expect(await collectNewDiagnostics(ROOT)).toEqual([])
  })

  it('DESLOCAMENTO de linha não cria falsos positivos', async () => {
    // O caso que matou a versão anterior: os edits removeram 4 linhas e cinco
    // erros pré-existentes desceram de posição, reaparecendo como "novos". O
    // modelo gastou seis turnos a perceber que era deslocamento. A assinatura
    // não inclui a posição precisamente por isto.
    invokeMock
      .mockResolvedValueOnce(tsc(
        E('/p/a.ts', 184, 7006, "Parameter 'email' implicitly has an 'any' type."),
        E('/p/a.ts', 333, 7006, "Parameter 'password' implicitly has an 'any' type."),
      ))
      .mockResolvedValueOnce(tsc(
        E('/p/a.ts', 180, 7006, "Parameter 'email' implicitly has an 'any' type."),
        E('/p/a.ts', 329, 7006, "Parameter 'password' implicitly has an 'any' type."),
      ))
    await startDiagnosticsBaseline(ROOT)
    markProjectEdited()
    expect(await collectNewDiagnostics(ROOT)).toEqual([])
  })

  it('apanha a referência pendurada — o defeito que motivou o guarda', async () => {
    invokeMock
      .mockResolvedValueOnce(tsc())
      .mockResolvedValueOnce(tsc(E('/p/src/hooks/useAuthRepository.ts', 240, 2339, DANGLING)))
    await startDiagnosticsBaseline(ROOT)
    markProjectEdited()
    const found = await collectNewDiagnostics(ROOT)
    expect(found).toHaveLength(1)
    expect(found[0].line).toBe(240)
    expect(found[0].code).toBe(2339)
  })

  it('erro em ficheiro NÃO editado é apanhado — cobertura cross-file', async () => {
    // O `tsc` vê o projeto inteiro: editar ApiClient.ts e partir
    // useAuthRepository.ts é detectado mesmo sem tocar no segundo. Era isto
    // que o worker lazy do Monaco não conseguia dar.
    invokeMock
      .mockResolvedValueOnce(tsc())
      .mockResolvedValueOnce(tsc(E('/p/outro.ts', 12, 2551, 'Property does not exist.')))
    await startDiagnosticsBaseline(ROOT)
    markProjectEdited()
    const found = await collectNewDiagnostics(ROOT)
    expect(found.map(d => d.file)).toEqual(['/p/outro.ts'])
  })

  it('a baseline AVANÇA — erro não corrigido não se repete', async () => {
    invokeMock
      .mockResolvedValueOnce(tsc())
      .mockResolvedValueOnce(tsc(E('/p/a.ts', 9, 2339, 'boom')))
      .mockResolvedValueOnce(tsc(E('/p/a.ts', 9, 2339, 'boom')))
    await startDiagnosticsBaseline(ROOT)
    markProjectEdited()
    expect(await collectNewDiagnostics(ROOT)).toHaveLength(1)
    markProjectEdited()
    expect(await collectNewDiagnostics(ROOT)).toEqual([])
  })

  it('turno sem edições não corre tsc nenhum', async () => {
    invokeMock.mockResolvedValueOnce(tsc())
    startDiagnosticsBaseline(ROOT)
    invokeMock.mockClear()
    expect(await collectNewDiagnostics(ROOT)).toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('projeto sem TypeScript desliga-se em silêncio e não volta a tentar', async () => {
    invokeMock.mockResolvedValue({
      stdout: '', stderr: "Cannot find module 'typescript'", exitCode: 1, success: false,
    })
    await startDiagnosticsBaseline(ROOT)
    markProjectEdited()
    expect(await collectNewDiagnostics(ROOT)).toEqual([])
    invokeMock.mockClear()
    markProjectEdited()
    expect(await collectNewDiagnostics(ROOT)).toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('comando a rebentar não bloqueia nem propaga', async () => {
    invokeMock.mockRejectedValue(new Error('spawn falhou'))
    await startDiagnosticsBaseline(ROOT)
    markProjectEdited()
    await expect(collectNewDiagnostics(ROOT)).resolves.toEqual([])
  })

  it('corre com --incremental — é o que torna o custo viável', async () => {
    invokeMock.mockResolvedValueOnce(tsc())
    await startDiagnosticsBaseline(ROOT)
    markProjectEdited()
    invokeMock.mockResolvedValueOnce(tsc())
    await collectNewDiagnostics(ROOT)
    const cmd = String(invokeMock.mock.calls[0][1].command)
    expect(cmd).toContain('--noEmit')
    expect(cmd).toContain('--incremental')
    expect(cmd).toContain('--pretty false')
    expect(invokeMock.mock.calls[0][1].cwd).toBe(ROOT)
  })

  it('o texto nomeia o type checker do projeto e usa caminho relativo', () => {
    const txt = formatDiagnosticsReminder(
      [{ file: '/p/src/hooks/useAuth.ts', line: 240, column: 17, severity: 'error', code: 2339, message: DANGLING }],
      '/p',
    )
    expect(txt).toContain('src/hooks/useAuth.ts:240:17')
    expect(txt).toContain('TS2339')
    expect(txt).toContain('1 new diagnostic (1 error)')
    expect(txt).toContain("project's own type checker")
    expect(txt).toContain('<system-reminder>')
  })

  it('sem achados o texto é vazio', () => {
    expect(formatDiagnosticsReminder([])).toBe('')
  })

  it('escreve o .tsbuildinfo FORA do projeto quando lhe dão um state dir', async () => {
    // Medido: sem isto ficava um ficheiro de 564 KB na raiz do developer, só
    // por termos verificado tipos. Neste projeto estava gitignored — por
    // sorte, não por desenho.
    invokeMock.mockResolvedValue(tsc())
    await startDiagnosticsBaseline(ROOT, '/state/proj-abc')
    markProjectEdited()
    await collectNewDiagnostics(ROOT)
    const cmd = String(invokeMock.mock.calls[0][1].command)
    expect(cmd).toContain('--tsBuildInfoFile')
    expect(cmd).toContain('/state/proj-abc/tsc-agent.tsbuildinfo')
    expect(cmd).not.toContain(`${ROOT}/tsconfig.tsbuildinfo`)
  })

  it('escrita ANTES de a baseline terminar não produz relatório enganador', async () => {
    // A baseline corre em background e lê do DISCO. Se um edit aterrar a meio,
    // ela já mede o ficheiro alterado: o delta sairia vazio e o guarda ficava
    // mudo sem falhar nada. Descarta-se esse turno e adopta-se o estado atual.
    let release: (v: unknown) => void = () => {}
    const deferred = new Promise(r => { release = r })
    invokeMock.mockReturnValueOnce(deferred)

    const started = startDiagnosticsBaseline(ROOT)
    markProjectEdited()                                  // edit ANTES de fechar
    release(tsc(E('/p/a.ts', 9, 2339, 'boom')))          // baseline chega tarde
    await started

    invokeMock.mockResolvedValueOnce(tsc(E('/p/a.ts', 9, 2339, 'boom')))
    expect(await collectNewDiagnostics(ROOT)).toEqual([])

    // Turno seguinte, baseline já confiável: um erro NOVO volta a ser reportado.
    markProjectEdited()
    invokeMock.mockResolvedValueOnce(tsc(
      E('/p/a.ts', 9, 2339, 'boom'),
      E('/p/b.ts', 4, 2551, 'novo'),
    ))
    const found = await collectNewDiagnostics(ROOT)
    expect(found.map(d => d.file)).toEqual(['/p/b.ts'])
  })
})
