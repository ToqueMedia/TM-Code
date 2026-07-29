/**
 * Detector de loops de TOOL CALLS (auditoria 2026-07-28).
 *
 * O detector de texto tinha um ponto cego por construção: só corre em turns
 * SEM tool calls, e qualquer tool call resetava o estado. Um modelo a repetir
 * a mesma chamada falhada para sempre era, por isso, invisível — foi assim que
 * o run momenu chegou a 151 pedidos.
 */
import {
  buildToolLoopNudgeText,
  checkForLoop,
  checkForToolLoop,
  computeToolBatchFingerprint,
  createLoopDetectorState,
  createToolLoopState,
} from '../loopDetector'
import { TOOL_LOOP_NUDGE_THRESHOLD, TOOL_LOOP_STOP_THRESHOLD } from '../agentConfig'

const call = (name: string, argsJson = '{}') => ({ name, argsJson })

/** Corre a mesma ronda N vezes e devolve o resultado de cada uma. */
function repeat(calls: Array<{ name: string; argsJson: string }>, times: number) {
  const state = createToolLoopState()
  return Array.from({ length: times }, () =>
    checkForToolLoop(computeToolBatchFingerprint(calls), state),
  )
}

describe('computeToolBatchFingerprint', () => {
  it('distingue rondas pelos ARGS, não só pelos nomes', () => {
    const a = computeToolBatchFingerprint([call('read_file', '{"file_path":"/a.ts"}')])
    const b = computeToolBatchFingerprint([call('read_file', '{"file_path":"/b.ts"}')])
    expect(a).not.toBe(b)
  })

  it('a mesma ronda produz a mesma impressão digital', () => {
    const args = '{"file_path":"/a.ts"}'
    expect(computeToolBatchFingerprint([call('read_file', args)])).toBe(
      computeToolBatchFingerprint([call('read_file', args)]),
    )
  })

  it('a ORDEM das calls conta (rondas diferentes, não a mesma)', () => {
    expect(computeToolBatchFingerprint([call('read_file'), call('glob')])).not.toBe(
      computeToolBatchFingerprint([call('glob'), call('read_file')]),
    )
  })

  it('isenta rondas 100% de polling — repetir é o que essas tools FAZEM', () => {
    expect(computeToolBatchFingerprint([call('check_background_commands')])).toBeNull()
    expect(computeToolBatchFingerprint([call('agent_shell_read')])).toBeNull()
  })

  it('uma ronda mista com polling NÃO é isenta (o resto pode estar em giro)', () => {
    expect(
      computeToolBatchFingerprint([call('check_background_commands'), call('read_file')]),
    ).not.toBeNull()
  })

  it('ronda vazia não é verificável', () => {
    expect(computeToolBatchFingerprint([])).toBeNull()
  })
})

describe('checkForToolLoop', () => {
  it('avisa ao atingir o limiar e para ao dobro', () => {
    const results = repeat([call('read_file', '{"file_path":"/a.ts"}')], TOOL_LOOP_STOP_THRESHOLD)

    const nudgeIndexes = results.flatMap((r, i) => (r.shouldNudge ? [i] : []))
    // Exatamente UM aviso por sequência — repeti-lo todos os turns seria spam.
    expect(nudgeIndexes).toEqual([TOOL_LOOP_NUDGE_THRESHOLD - 1])
    expect(results[TOOL_LOOP_STOP_THRESHOLD - 1].shouldStop).toBe(true)
    // Nada dispara antes do limiar: retries legítimos não são punidos.
    expect(results.slice(0, TOOL_LOOP_NUDGE_THRESHOLD - 1).some(r => r.shouldNudge || r.shouldStop)).toBe(false)
  })

  it('uma ronda DIFERENTE zera a contagem (progresso real)', () => {
    const state = createToolLoopState()
    const same = computeToolBatchFingerprint([call('read_file', '{"file_path":"/a.ts"}')])
    checkForToolLoop(same, state)
    checkForToolLoop(same, state)
    const moved = checkForToolLoop(
      computeToolBatchFingerprint([call('read_file', '{"file_path":"/b.ts"}')]),
      state,
    )
    expect(moved.repeats).toBe(1)
    expect(moved.shouldNudge).toBe(false)

    // E a partir daqui volta a precisar do limiar completo.
    const back = Array.from({ length: TOOL_LOOP_NUDGE_THRESHOLD - 1 }, () =>
      checkForToolLoop(computeToolBatchFingerprint([call('read_file', '{"file_path":"/b.ts"}')]), state),
    )
    expect(back[back.length - 1].shouldNudge).toBe(true)
  })

  it('polling infinito nunca dispara nem stop nem nudge', () => {
    const state = createToolLoopState()
    const polls = Array.from({ length: TOOL_LOOP_STOP_THRESHOLD * 3 }, () =>
      checkForToolLoop(computeToolBatchFingerprint([call('check_background_commands')]), state),
    )
    expect(polls.some(r => r.shouldNudge || r.shouldStop)).toBe(false)
  })

  it('o aviso diz ao modelo o que MUDAR, não só que parou', () => {
    const text = buildToolLoopNudgeText(3)
    expect(text).toContain('3 times in a row')
    expect(text).toContain('different arguments')
    expect(text).toContain('different tool')
  })
})

describe('checkForLoop — detector de TEXTO vê a janela inteira', () => {
  // O filler tem de derivar do seed: um filler PARTILHADO tornava textos
  // "diferentes" >70% Jaccard e o teste negativo falhava por defeito do
  // próprio teste, não do detector.
  const longText = (seed: string) => `${seed}. `.repeat(12)

  it('apanha a alternância A-B-A-B (a comparação 1-a-1 era cega a isto)', () => {
    // Auditoria 2026-07-28: comparar só com o imediatamente anterior deixava
    // o modelo alternar entre duas respostas para sempre — cada uma era
    // "diferente da anterior" e o contador nunca subia.
    const state = createLoopDetectorState()
    const a = longText('hipótese alfa sobre o bug do worker')
    const b = longText('hipótese beta sobre o bug do worker')
    const results = [a, b, a, b, a, b].map((t) => checkForLoop(t, state))
    expect(results.some(r => r.isLoop)).toBe(true)
  })

  it('textos genuinamente diferentes nunca disparam', () => {
    const state = createLoopDetectorState()
    const texts = [
      longText('primeiro passo: ler o ficheiro de configuração e validar o schema'),
      longText('segundo passo completamente distinto: correr a suite de testes de integração'),
      longText('terceiro passo: publicar a build e verificar os logs de produção do worker'),
    ]
    const results = texts.map((t) => checkForLoop(t, state))
    expect(results.every(r => !r.isLoop)).toBe(true)
  })
})
