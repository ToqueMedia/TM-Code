/**
 * Sonda do prefix cache do Workers AI — endpoint NATIVO (`/ai/run/...`) contra
 * o OpenAI-compatible (`/ai/v1/chat/completions`).
 *
 * PORQUÊ: a doc do `x-session-affinity` só o documenta para REST nativo e para
 * o binding. Medimos a 2026-08-12 que no endpoint OpenAI-compatible ele é
 * IGNORADO (chave aleatória por pedido = chave constante; ver
 * cf-cache-probe-key.mjs). A pergunta que sobra vale dinheiro: no caminho
 * NATIVO a afinidade funciona, e chega-se aos ~95% do DashScope/z.AI?
 *
 * Protocolo igual ao das outras sondas: prefixo grande e estável, um prefixo
 * PRÓPRIO por braço (para nenhum aquecer o do outro) e pedidos INTERCALADOS
 * (mesma carga e mesma hora nos dois).
 *
 * GASTA INFERÊNCIA REAL (~35K tokens de prompt por pedido).
 */
import { readFileSync } from 'node:fs'

const ACCOUNT = '871d5952ee10006122034a6ad8a71474'
const MODEL = '@cf/zai-org/glm-5.2'
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai`

const devVars = readFileSync('/Users/ithustle/dev/deskotp/exodus-ide/workers/ai-pass-through/.dev.vars', 'utf8')
const TOKEN = devVars.match(/^CLOUDFLARE_AI_GATEWAY_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
if (!TOKEN) throw new Error('CLOUDFLARE_AI_GATEWAY_TOKEN não encontrado no .dev.vars')

function systemFor(salt) {
  const filler = Array.from({ length: 900 }, (_, i) =>
    `[${salt}] Regra ${i}: o módulo ${i} trata do caso ${i % 7} e devolve ${(i * 31) % 997}. ` +
    `Nunca antes do módulo ${Math.max(0, i - 1)}.`,
  ).join('\n')
  return `És um assistente de manutenção de um sistema com muitas regras.\n\n${filler}`
}

const msgs = (system, turn) => ([
  { role: 'system', content: system },
  { role: 'user', content: 'Responde apenas com OK.' },
  { role: 'assistant', content: 'OK' },
  { role: 'user', content: `Turno ${turn}. Responde apenas com OK.` },
])

/** `nativo` troca a URL E a forma do corpo/resposta — é essa a variável. */
async function one({ nativo, system, affinity, turn }) {
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  if (affinity) headers['x-session-affinity'] = affinity
  const url = nativo ? `${BASE}/run/${MODEL}` : `${BASE}/v1/chat/completions`
  const body = nativo
    ? { messages: msgs(system, turn), max_tokens: 8, temperature: 0 }
    : { model: MODEL, messages: msgs(system, turn), max_tokens: 8, temperature: 0 }
  const t0 = Date.now()
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const ms = Date.now() - t0
  const txt = await res.text()
  if (!res.ok) return { erro: `${res.status} ${txt.slice(0, 160)}`, ms }
  let j
  try { j = JSON.parse(txt) } catch { return { erro: `não-JSON ${txt.slice(0, 160)}`, ms } }
  // Nativo embrulha em `result`; o compat devolve na raiz.
  const u = (nativo ? j.result?.usage : j.usage) ?? {}
  return {
    p: u.prompt_tokens ?? 0,
    c: u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0,
    neurons: u.neurons ?? 0,
    ms,
    cru: u,
  }
}

const N = Number(process.argv[2] ?? 12)

const bracos = [
  { nome: 'NATIVO  · chave CONSTANTE ', nativo: true, system: systemFor('NAT_C'), key: 'tm_native_const', r: [] },
  { nome: 'NATIVO  · chave ALEATÓRIA ', nativo: true, system: systemFor('NAT_R'), key: 'RANDOM', r: [] },
  { nome: 'COMPAT  · chave CONSTANTE ', nativo: false, system: systemFor('CMP_C'), key: 'tm_compat_const', r: [] },
]

console.log(`${MODEL} · ${N} pedidos/braço · INTERCALADO · prefixos distintos\n`)

for (let i = 0; i < N; i++) {
  for (const b of bracos) {
    const affinity = b.key === 'RANDOM' ? `tm_rand_${Math.random().toString(36).slice(2)}` : b.key
    const r = await one({ nativo: b.nativo, system: b.system, affinity, turn: i })
    if (r.erro) { if (i < 2) console.log(`  ${b.nome} #${i} ERRO ${r.erro}`); b.r.push({ erro: true }); continue }
    if (i === 0) console.log(`  ${b.nome} usage CRU: ${JSON.stringify(r.cru)}`)
    b.r.push(r)
  }
}
console.log()

for (const b of bracos) {
  const ok = b.r.filter(x => !x.erro)
  if (ok.length === 0) { console.log(`── ${b.nome}\n   TODOS os pedidos falharam\n`); continue }
  const hits = ok.filter(x => x.c > 0).length
  const totP = ok.reduce((a, x) => a + x.p, 0)
  const totC = ok.reduce((a, x) => a + x.c, 0)
  const lat = ok.map(x => x.ms).sort((a, b2) => a - b2)
  console.log(`── ${b.nome}`)
  console.log(`   padrão   : ${b.r.map(x => (x.erro ? 'E' : x.c > 0 ? 'H' : '.')).join('')}`)
  console.log(`   HITS     : ${hits}/${ok.length}  (${(hits / ok.length * 100).toFixed(0)}%)`)
  console.log(`   cache agg: ${totP ? (totC / totP * 100).toFixed(1) : 0}%`)
  console.log(`   neurons  : ${Math.round(ok.reduce((a, x) => a + x.neurons, 0))}`)
  console.log(`   latência : mediana ${lat[Math.floor(lat.length / 2)]}ms\n`)
}
