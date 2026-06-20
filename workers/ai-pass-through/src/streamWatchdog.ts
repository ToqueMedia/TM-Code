/**
 * Watchdog de INATIVIDADE para o corpo do stream do upstream.
 *
 * O header-timeout (index.ts) só cobre até ao PRIMEIRO byte: assim que os
 * headers do upstream chegam o seu timer é limpo (clearTimeout no finally do
 * fetch) e, a partir daí, NADA supervisiona o stream. Um provider que devolve
 * 200 + headers depressa mas depois estola a meio da geração (nunca manda o
 * chunk final de usage/[DONE], nunca fecha a ligação) deixava a Response aberta
 * até o runtime a matar com "The Workers runtime canceled this request because
 * it detected that your Worker's code had hung and would never generate a
 * response" — o gémeo PÓS-headers exato do incidente que o header-timeout
 * corrigiu (lines 31-45 em index.ts; visto em produção 2026-06-17).
 *
 * Implementado como um ReadableStream PREGUIÇOSO (não um pipeThrough): só
 * puxa do upstream quando o consumidor (runtime → cliente) puxa. Isto é
 * deliberado — um pipeThrough/TransformStream começaria a DRENAR o upstream
 * mal fosse construído, o que faria o stream terminar (e o commit de billing
 * em waitUntil disparar) mesmo quando ninguém lê o corpo. Preguiçoso preserva
 * exatamente a semântica original: o corpo só flui à medida que o cliente o lê.
 *
 * Por cada `pull` corremos `reader.read()` numa corrida com um timer de
 * `idleMs`; se o timer ganhar (sem bytes nesse intervalo), abortamos o upstream
 * (o MESMO AbortController do fetch — o abort propaga e liberta a ligação) e
 * fazemos `error()` do readable, para o cliente receber um stream truncado/erro
 * em vez de um chat pendurado. O timer é re-armado a cada chunk e limpo em
 * cada resultado/cancel — sem timers pendurados a manter o isolate vivo. Os
 * bytes que saem são EXATAMENTE os que entram (identity; mantém o contrato de
 * pass-through do worker, ver usage.ts).
 */

const IDLE = Symbol('idle')

export function withStreamIdleTimeout(
  body: ReadableStream<Uint8Array>,
  onIdle: () => void,
  idleMs: number,
): ReadableStream<Uint8Array> {
  // Knob desligado (0/negativo) ou inválido → devolve o corpo intacto, sem
  // watchdog e sem o reader/wrapper preguiçoso.
  if (!Number.isFinite(idleMs) || idleMs <= 0) return body

  // Lock ADIADO: só agarramos o reader no primeiro `pull` real. Agarrá-lo na
  // construção bloquearia (`getReader` lock) o corpo do upstream mesmo quando
  // ninguém o lê — e um corpo nunca-lido continuaria locked, partindo qualquer
  // releitura. Lazy = o watchdog não toca no stream até o cliente o consumir.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const r = reader ?? (reader = body.getReader())
      const idle = new Promise<typeof IDLE>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), idleMs)
      })

      let result: ReadableStreamReadResult<Uint8Array> | typeof IDLE
      try {
        result = await Promise.race([r.read(), idle])
      } catch (err) {
        // Upstream errou/abortou (ex.: outro abort do mesmo controller) —
        // propaga e termina.
        clear()
        controller.error(err)
        return
      }
      clear()

      if (result === IDLE) {
        // Sem bytes durante idleMs → upstream estolado. Aborta o fetch e erra
        // o readable; o read() pendente resolve-se sozinho com o cancel.
        try { onIdle() } catch { /* abort best-effort */ }
        void r.cancel().catch(() => { /* já fechado */ })
        controller.error(new Error('upstream stream idle timeout'))
        return
      }

      if (result.done) {
        controller.close()
        return
      }
      controller.enqueue(result.value)
    },
    cancel(reason) {
      // Cliente desligou → limpa o timer e propaga o cancel ao upstream
      // (direto ao body se ainda não tínhamos agarrado o reader).
      clear()
      return reader ? reader.cancel(reason) : body.cancel(reason)
    },
  // highWaterMark 0 = SEM pull proativo: o `pull` (e portanto a leitura do
  // upstream) só corre quando o consumidor real pede um chunk. Com o default
  // (1) o stream puxava um chunk mal fosse construído, e numa resposta de 1
  // chunk isso cascateava o dreno do observeUsage até ao fim → o commit de
  // billing em waitUntil disparava mesmo sem ninguém ler o corpo. Preguiçoso
  // de propósito: o watchdog vigia, não consome.
  }, { highWaterMark: 0 })
}
