/**
 * O `X-Request-Type` que o cliente envia TEM de existir no mapa do worker.
 *
 * Observado em produção (2026-07-31): enviei `utility`, que é o nome do
 * SIDECAR e não do PEDIDO. O `sidecarKeyForRequestType` devolveu null, o
 * worker degradou silenciosamente para a config activa (comportamento
 * documentado: "sidecar ausente/inválido → degrada para a config ativa"), e
 * este cliente descartou a resposta por o `x-tm-config-key` não bater.
 * Resultado: chamada ao modelo PAGA e deitada fora, três runs seguidas, com
 * a mensagem "sem sidecar utility" a sugerir config em falta no KV quando o
 * problema era o nome que eu inventei.
 *
 * Este teste lê o mapa REAL do worker (mesmo repositório) em vez de repetir a
 * lista — se alguém lá mexer, isto acusa.
 */
import * as fs from 'fs'
import * as path from 'path'

const WORKER_CONFIG = path.join(
  __dirname, '..', '..', '..', '..', 'workers', 'ai-pass-through', 'src', 'activeConfig.ts',
)

/** Nomes de request-type que o worker reconhece, lidos da fonte dele. */
function workerRequestTypes(): Set<string> {
  const src = fs.readFileSync(WORKER_CONFIG, 'utf8')
  const block = src.slice(
    src.indexOf('REQUEST_TYPE_TO_SIDECAR_KEY'),
    src.indexOf('export function sidecarKeyForRequestType'),
  )
  return new Set([...block.matchAll(/'([a-z0-9_-]+)':\s*'sidecar:/g)].map(m => m[1]))
}

/** O que o cliente do web-fetch envia. */
function clientRequestType(): string {
  const src = fs.readFileSync(path.join(__dirname, '..', 'fetchSidecar.ts'), 'utf8')
  const m = /'X-Request-Type':\s*'([^']+)'/.exec(src)
  if (!m) throw new Error('X-Request-Type não encontrado no fetchSidecar')
  return m[1]
}

describe('fetchSidecar — request type', () => {
  it('o worker conhece o request-type que enviamos', () => {
    const known = workerRequestTypes()
    // Sanidade: se o parse falhar, o teste passaria por vazio.
    expect(known.size).toBeGreaterThan(3)
    expect([...known]).toContain(clientRequestType())
  })

  it('esse request-type aponta para o sidecar utility (modelo barato)', () => {
    const src = fs.readFileSync(WORKER_CONFIG, 'utf8')
    expect(src).toMatch(new RegExp(`'${clientRequestType()}':\\s*'sidecar:utility'`))
  })

  it('NÃO enviamos o nome do sidecar como se fosse o do pedido', () => {
    // `utility`, `vision`, `web_search` e `fim` são nomes de SIDECAR. Só
    // alguns são também request-types (vision/web_search/fim são; utility
    // não é) — e foi exactamente aí que tropecei.
    expect(clientRequestType()).not.toBe('utility')
  })
})
