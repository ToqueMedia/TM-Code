/**
 * O corpo do CLIENTE tem tecto de leitura.
 *
 * Terceiro buraco da mesma família de hangs. Já havia dois watchdogs — o
 * header-timeout (upstream até ao 1º byte) e o stream-idle (corpo do upstream
 * depois disso) — e ambos foram escritos DEPOIS de o runtime matar pedidos com
 * "code had hung and would never generate a response". Nenhum deles olha para o
 * corpo que o cliente nos envia.
 *
 * `await request.json()` espera para sempre se o cliente abre o POST, manda os
 * headers e estola a meio do upload: TCP vivo, bytes parados. Nesse estado
 * `request.signal` NÃO dispara, porque o cliente não abortou — o listener de
 * abort não salva. Visto em produção entre 26-07 e 01-08 (versão dbc1f8f5).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveClientBodyTimeout } from '../src/index'

test('default de 60s quando o env não define', () => {
  assert.equal(resolveClientBodyTimeout({} as never), 60_000)
})

test('env override é respeitado', () => {
  assert.equal(resolveClientBodyTimeout({ CLIENT_BODY_TIMEOUT_MS: '5000' } as never), 5_000)
})

test('0 desliga deliberadamente (mesma convenção dos outros knobs)', () => {
  assert.equal(resolveClientBodyTimeout({ CLIENT_BODY_TIMEOUT_MS: '0' } as never), 0)
})

test('valor inválido cai no default em vez de desligar', () => {
  // "abc" → NaN. Desligar o watchdog por causa de um typo no env seria o pior
  // dos dois erros: volta a pendurar pedidos, em silêncio.
  assert.equal(resolveClientBodyTimeout({ CLIENT_BODY_TIMEOUT_MS: 'abc' } as never), 60_000)
})

// ── O comportamento, não só o knob ───────────────────────────────────────────
//
// bodyWithActiveModel não é exportado; o que se testa aqui é a semântica da
// corrida que lá está, com a MESMA forma. O ponto crítico é o tipo do erro:
// se o timeout saísse como "must be valid JSON", mandava quem depura procurar
// um bug de serialização no cliente em vez de um upload estolado.

class HttpErrorLike extends Error {
  constructor(readonly status: number, readonly type: string) { super(type) }
}

/** Réplica da corrida em bodyWithActiveModel. */
async function readWithTimeout<T>(read: Promise<T>, ms: number): Promise<T> {
  try {
    return ms > 0
      ? await Promise.race([
        read,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new HttpErrorLike(408, 'tm_request_body_timeout')), ms,
        )),
      ])
      : await read
  } catch (err) {
    if (err instanceof HttpErrorLike) throw err
    throw new HttpErrorLike(400, 'tm_bad_request')
  }
}

test('upload estolado → 408, NÃO 400 de JSON inválido', async () => {
  const nunca = new Promise<unknown>(() => { /* o upload que nunca acaba */ })
  await assert.rejects(
    () => readWithTimeout(nunca, 20),
    (e: HttpErrorLike) => e.status === 408 && e.type === 'tm_request_body_timeout',
  )
})

test('JSON malformado continua a dar 400', async () => {
  await assert.rejects(
    () => readWithTimeout(Promise.reject(new SyntaxError('bad json')), 1000),
    (e: HttpErrorLike) => e.status === 400 && e.type === 'tm_bad_request',
  )
})

test('corpo que chega a tempo passa intacto', async () => {
  const body = { model: 'glm-5.2', messages: [] }
  assert.deepEqual(await readWithTimeout(Promise.resolve(body), 1000), body)
})

test('com o knob a 0 não há corrida — espera pelo corpo', async () => {
  const body = { ok: true }
  assert.deepEqual(await readWithTimeout(Promise.resolve(body), 0), body)
})

test('o caminho feliz NÃO deixa o timer armado', async () => {
  // A primeira versão desta corrida não fazia clearTimeout: no caminho feliz o
  // timer ficava armado o intervalo todo, em TODOS os pedidos. Só deu nas
  // vistas porque a suite saltou de 3s para 60s — um sinal que só se nota por
  // acaso. Aqui conta-se explicitamente.
  let armed = 0
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = ((fn: never, ms: number) => {
    armed++
    return realSet(fn, ms)
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: never) => {
    armed--
    return realClear(id)
  }) as typeof clearTimeout
  try {
    await readWithTimeoutClearing(Promise.resolve({ ok: true }), 60_000)
    assert.equal(armed, 0, 'timer ficou armado depois de o corpo chegar')
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
})

/** Réplica da corrida COM o finally — a forma que está em produção. */
async function readWithTimeoutClearing<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return ms > 0
      ? await Promise.race([
        read,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HttpErrorLike(408, 'tm_request_body_timeout')), ms)
        }),
      ])
      : await read
  } catch (err) {
    if (err instanceof HttpErrorLike) throw err
    throw new HttpErrorLike(400, 'tm_bad_request')
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
