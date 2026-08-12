/**
 * Sonda do prefix cache do Workers AI — braço COM header vs SEM header.
 *
 * Par de `cf-cache-probe-key.mjs` (chave constante vs aleatória), que é o
 * teste DECISIVO. Correr os dois; os resultados de 2026-08-12 e a conclusão
 * ("o header é ignorado no endpoint OpenAI-compatible") estão em
 * docs/HANDOFF-CACHE-E-DEFERRAL.md §3.
 *
 * Direta ao provider: sem o nosso worker, sem KV, sem IDE. Requer
 * CLOUDFLARE_AI_GATEWAY_TOKEN no workers/ai-pass-through/.dev.vars.
 * GASTA INFERÊNCIA REAL (~35K tokens de prompt por pedido).
 *
 * Na v1 os dois braços partilhavam o MESMO prefixo e correram em série, logo o
 * segundo braço herdou as instâncias que o primeiro aqueceu. Aqui cada braço
 * tem o SEU prefixo (nenhum aquece o do outro) e os pedidos são INTERCALADOS
 * (mesmas condições de carga e de hora nos dois).
 *
 * Hipótese que a v1 levantou e que isto testa: a afinidade PRENDE a sessão a
 * uma instância. Sem header, o pedido pode aterrar em QUALQUER instância — e
 * se o prefixo já estiver replicado por várias, "qualquer uma" ganha a "uma
 * específica". A ser verdade, a afinidade está a fazer mal, não bem.
 */
import { readFileSync } from 'node:fs'

const ACCOUNT = '871d5952ee10006122034a6ad8a71474'
const MODEL = '@cf/zai-org/glm-5.2'
const URL_ = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`

const devVars = readFileSync('/Users/ithustle/dev/deskotp/exodus-ide/workers/ai-pass-through/.dev.vars', 'utf8')
const TOKEN = devVars.match(/^CLOUDFLARE_AI_GATEWAY_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
if (!TOKEN) throw new Error('token não encontrado')

/** Prefixo grande e ÚNICO por braço — `salt` garante que não se cruzam. */
function systemFor(salt) {
  const filler = Array.from({ length: 900 }, (_, i) =>
    `[${salt}] Regra ${i}: o módulo ${i} trata do caso ${i % 7} e devolve ${(i * 31) % 997}. ` +
    `Nunca antes do módulo ${Math.max(0, i - 1)}.`,
  ).join('\n')
  return `És um assistente de manutenção de um sistema com muitas regras.\n\n${filler}`
}

async function one(system, affinity, turn) {
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  if (affinity) headers['x-session-affinity'] = affinity
  const t0 = Date.now()
  const res = await fetch(URL_, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Responde apenas com OK.' },
        { role: 'assistant', content: 'OK' },
        { role: 'user', content: `Turno ${turn}. Responde apenas com OK.` },
      ],
    }),
  })
  const ms = Date.now() - t0
  const txt = await res.text()
  if (!res.ok) return { erro: `${res.status} ${txt.slice(0, 120)}`, ms }
  const u = JSON.parse(txt).usage ?? {}
  return {
    p: u.prompt_tokens ?? 0,
    c: u.prompt_tokens_details?.cached_tokens ?? 0,
    neurons: u.neurons ?? 0,
    ms,
  }
}

const N = Number(process.argv[2] ?? 12)
const bracos = [
  { nome: 'COM x-session-affinity', system: systemFor('AFF'), affinity: 'tm_probe_v2_aff', r: [] },
  { nome: 'SEM header           ', system: systemFor('NOAFF'), affinity: null, r: [] },
]

console.log(`${MODEL} · ${N} pedidos/braço · INTERCALADO · prefixos distintos\n`)

for (let i = 0; i < N; i++) {
  for (const b of bracos) {
    const r = await one(b.system, b.affinity, i)
    if (r.erro) { console.log(`  ${b.nome} #${i} ERRO ${r.erro}`); continue }
    b.r.push(r)
  }
}

for (const b of bracos) {
  const hits = b.r.filter(x => x.c > 0).length
  const totP = b.r.reduce((a, x) => a + x.p, 0)
  const totC = b.r.reduce((a, x) => a + x.c, 0)
  const neurons = b.r.reduce((a, x) => a + x.neurons, 0)
  const lat = b.r.map(x => x.ms).sort((a, b2) => a - b2)
  console.log(`── ${b.nome}`)
  console.log(`   padrão   : ${b.r.map(x => (x.c > 0 ? 'H' : '.')).join('')}`)
  console.log(`   HITS     : ${hits}/${b.r.length}  (${(hits / b.r.length * 100).toFixed(0)}%)`)
  console.log(`   cache agg: ${totP ? (totC / totP * 100).toFixed(1) : 0}%`)
  console.log(`   neurons  : ${Math.round(neurons)}  (proxy directo de custo)`)
  console.log(`   latência : mediana ${lat[Math.floor(lat.length / 2)]}ms\n`)
}
