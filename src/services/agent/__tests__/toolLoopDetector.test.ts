/**
 * Detector de loops de TOOL CALLS (auditoria 2026-07-28).
 *
 * O detector de texto tinha um ponto cego por construção: só corre em turns
 * SEM tool calls, e qualquer tool call resetava o estado. Um modelo a repetir
 * a mesma chamada falhada para sempre era, por isso, invisível — foi assim que
 * o run momenu chegou a 151 pedidos.
 */
import {
  buildRepeatedCallNoteText,
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

/**
 * Repetição ESPAÇADA — a que o detector consecutivo não vê.
 *
 * `lastFingerprint` só compara com a ronda anterior: qualquer ronda diferente
 * pelo meio põe o contador a 1. Medido na sessão yyyy (2026-07-30):
 * `Grep("seed-premium", functions/)` correu na ronda 2 e EXACTAMENTE outra vez
 * na ronda 12 — mesma tool, mesmos args, mesmo "No matches found." — com 9
 * rondas diferentes entre as duas. O detector não viu nada. Não é um ciclo
 * infinito; é um turno inteiro gasto a reconfirmar um "não existe" que já
 * estava no contexto.
 *
 * O aviso NÃO esconde nada: a chamada corre e o resultado chega inteiro. A
 * medição do próprio claude-vaz mostra porquê — duas Greps idênticas devolveram
 * resultados DIFERENTES (1 e 2 acertos) porque o ficheiro mudou entre elas.
 * Suprimir seria repetir o erro do read-dedup.
 */
describe('repetição espaçada da mesma chamada', () => {
  const fp = (name: string, args: string) =>
    computeToolBatchFingerprint([{ name, argsJson: args }])

  it('assinala a chamada exacta repetida rondas mais tarde', () => {
    const state = createToolLoopState()
    const target = fp('search_files', '{"query":"seed-premium"}')

    expect(checkForToolLoop(target, state).repeatedFromRound).toBeNull()
    // Nove rondas diferentes pelo meio — como na sessão real.
    for (let i = 0; i < 9; i++) {
      expect(checkForToolLoop(fp('search_files', `{"query":"q${i}"}`), state).repeatedFromRound).toBeNull()
    }
    const again = checkForToolLoop(target, state)
    expect(again.repeatedFromRound).toBe(1)
    // E não é confundido com um ciclo: nada de stop nem de nudge consecutivo.
    expect(again.shouldStop).toBe(false)
    expect(again.shouldNudge).toBe(false)
  })

  it('assinala UMA vez por impressão digital — o aviso não é spam', () => {
    const state = createToolLoopState()
    const target = fp('glob', '{"pattern":"**/*.ts"}')

    checkForToolLoop(target, state)
    checkForToolLoop(fp('glob', '{"pattern":"x"}'), state)
    expect(checkForToolLoop(target, state).repeatedFromRound).toBe(1)
    checkForToolLoop(fp('glob', '{"pattern":"y"}'), state)
    expect(checkForToolLoop(target, state).repeatedFromRound).toBeNull()
  })

  it('não assinala a repetição CONSECUTIVA — essa já tem o seu próprio caminho', () => {
    const state = createToolLoopState()
    const target = fp('search_files', '{"query":"a"}')

    checkForToolLoop(target, state)
    const second = checkForToolLoop(target, state)
    expect(second.repeats).toBe(2)
    expect(second.repeatedFromRound).toBeNull()
  })

  it('args diferentes nunca são repetição, mesmo com a mesma tool', () => {
    const state = createToolLoopState()
    checkForToolLoop(fp('search_files', '{"query":"a"}'), state)
    checkForToolLoop(fp('search_files', '{"query":"b"}'), state)
    expect(checkForToolLoop(fp('search_files', '{"query":"c"}'), state).repeatedFromRound).toBeNull()
  })

  it('rondas de polling não contam nem contaminam o registo', () => {
    const state = createToolLoopState()
    const target = fp('search_files', '{"query":"a"}')

    checkForToolLoop(target, state)
    // fingerprint null (ronda só de polling) reseta o consecutivo mas NÃO pode
    // apagar a memória do run — senão a repetição espaçada volta a ser invisível.
    expect(checkForToolLoop(null, state).repeatedFromRound).toBeNull()
    expect(checkForToolLoop(target, state).repeatedFromRound).toBe(1)
  })

  it('o texto do aviso diz a ronda e o que fazer em vez de repetir', () => {
    const text = buildRepeatedCallNoteText(2)
    expect(text).toContain('round 2')
    expect(text).toContain('asking again will not either')
    // O resultado é SERVIDO — nada de "usa o que já tens".
    expect(text).toContain('The result below is what you got then')
  })
})
