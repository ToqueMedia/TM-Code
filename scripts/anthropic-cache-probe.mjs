/**
 * O cache_control da Anthropic funciona com a forma que o TM Code envia?
 *
 * Reproduz o shape do anthropicAdapter: system em blocos com breakpoint no
 * prefixo estático, breakpoint na última tool, breakpoint no último bloco da
 * última mensagem. Três pedidos: o 1º escreve o cache, o 2º devia LER, o 3º
 * simula o que a deferral faz — ACRESCENTA UMA TOOL a meio da conversa.
 *
 * A doc é explícita: as tools renderizam na posição 0, portanto mudar o array
 * invalida TUDO. É a hipótese principal para "o Claude Opus não registava
 * cache". GASTA TOKENS REAIS.
 */
import { readFileSync } from 'node:fs'
const dv = readFileSync('/Users/ithustle/dev/deskotp/exodus-ide/workers/ai-pass-through/.dev.vars','utf8')
const KEY = dv.match(/^ANTHROPIC_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g,'')
if (!KEY) throw new Error('ANTHROPIC_API_KEY não encontrada')
const MODEL = process.argv[2] ?? 'claude-opus-4-8'

const filler = Array.from({length:1200},(_,i)=>`Regra ${i}: o modulo ${i} trata do caso ${i%7} e devolve ${(i*31)%997}.`).join('\n')
const SYSTEM = `Assistente de manutencao.\n\n${filler}`
const baseTool = (n) => ({ name:`tool_${n}`, description:`Ferramenta ${n} para operacoes do tipo ${n}.`,
  input_schema:{type:'object',properties:{q:{type:'string'}},required:['q']} })

async function call(nTools, turn) {
  const tools = Array.from({length:nTools},(_,i)=>baseTool(i))
  tools[tools.length-1].cache_control = { type:'ephemeral' }
  const messages = [{ role:'user', content:[{ type:'text', text:`Turno ${turn}. Responde OK.`, cache_control:{type:'ephemeral'} }] }]
  const res = await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{ 'x-api-key':KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
    body: JSON.stringify({ model:MODEL, max_tokens:16,
      system:[{type:'text',text:SYSTEM,cache_control:{type:'ephemeral'}}], tools, messages }),
  })
  const txt = await res.text()
  if (!res.ok) return { erro:`${res.status} ${txt.slice(0,300)}` }
  return { u: JSON.parse(txt).usage }
}

console.log(`${MODEL} · system ~${Math.round(SYSTEM.length/4)} tokens · 3 breakpoints\n`)
for (const [rot, n, t] of [['#1  8 tools (escreve)',8,0],['#2  8 tools (devia LER)',8,1],['#3  9 tools (+1 a meio)',9,2],['#4  9 tools (devia LER)',9,3]]) {
  const r = await call(n,t)
  if (r.erro) { console.log(`${rot}: ERRO ${r.erro}`); continue }
  const u=r.u
  console.log(`${rot}: input=${u.input_tokens} write=${u.cache_creation_input_tokens ?? 0} READ=${u.cache_read_input_tokens ?? 0}`)
}
