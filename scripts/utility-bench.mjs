#!/usr/bin/env node
/**
 * utility-bench — mede se um modelo serve como sidecar:utility do TM Code.
 *
 * Contexto (2026-08-04): candidato qwen3.7-flash (DashScope) para substituir o
 * fallback flagship nos tipos memory-x/summarize/utility. O flash saiu SEM
 * benchmarks oficiais (nem blog, nem scores) — este bench é a nossa régua.
 *
 * Doutrina igual à dos agent-evals: os casos usam os PROMPTS REAIS dos
 * call-sites de produção (memoryExtractor, memorySelector, compact/prompt,
 * fetchSidecar, promptImprovementService — copiados verbatim; se o prompt de
 * produção mudar, actualizar aqui). Validação determinística por strings/JSON,
 * sem juiz-LLM: o que se mede é contrato, não gosto.
 *
 * Métricas por variante: taxa de validade, fuga de raciocínio (<think> inline
 * em content — gotcha nonstreaming-reasoning-leak), latência mediana/p95,
 * timeouts (proxy do P99 de 90s reportado no OpenRouter), tokens.
 *
 * Uso:
 *   node scripts/utility-bench.mjs                # 3 variantes × 6 casos × 5 reps
 *   node scripts/utility-bench.mjs --reps 3
 *   node scripts/utility-bench.mjs --only flash-nothink
 *   node scripts/utility-bench.mjs --model qwen3.7-flash   # id DashScope alternativo
 *
 * Chave: DASHSCOPE_API_KEY do ambiente, senão workers/ai-pass-through/.dev.vars.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
function argValue(flag, fallback) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const REPS = Number(argValue('--reps', '5'))
const ONLY_VARIANT = argValue('--only', null)
const FLASH_MODEL = argValue('--model', 'qwen3.7-flash')
const TIMEOUT_MS = 120_000

// ── Chave ──────────────────────────────────────────────────────────────────
function loadDashscopeKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY
  const devVars = readFileSync(path.join(ROOT, 'workers/ai-pass-through/.dev.vars'), 'utf8')
  const m = devVars.match(/^DASHSCOPE_API_KEY=(.+)$/m)
  if (!m) throw new Error('DASHSCOPE_API_KEY não encontrada (env nem .dev.vars)')
  return m[1].trim()
}
const API_KEY = loadDashscopeKey()
const BASE_URL = 'https://dashscope-us.aliyuncs.com/compatible-mode/v1'

// ── Variantes sob teste ────────────────────────────────────────────────────
// flash-nothink: a config que iríamos publicar no KV (extraBody.enable_thinking:false).
// flash-think:   o default do modelo (thinking ON) — mede fuga + custo de latência.
// glm-nothink:   baseline de qualidade — o que o fallback flagship dá hoje aos
//                tipos utility (glm-5.2, thinking off para comparar latência justa).
const VARIANTS = [
  { key: 'flash-nothink', model: FLASH_MODEL, extraBody: { enable_thinking: false } },
  { key: 'flash-think', model: FLASH_MODEL, extraBody: {} },
  { key: 'glm-nothink', model: 'glm-5.2', extraBody: { enable_thinking: false } },
].filter(v => !ONLY_VARIANT || v.key === ONLY_VARIANT)

// ── Prompts reais (verbatim dos call-sites) ────────────────────────────────

const MAX_PROPOSALS_PER_RUN = 5 // memoryExtractor.ts
const MAX_SELECTED_ENTRIES = 30 // memorySelector.ts

const EXTRACTOR_SYSTEM = `You read one conversation turn and propose memories worth persisting across future sessions.

A memory belongs to one of FOUR types (closed taxonomy):
- \`user\`: developer's role, expertise, working style. Helps frame future explanations.
- \`feedback\`: explicit correction ("don't X") OR validated approach ("yes exactly, do X"). Save with **Why:** and **How to apply:** lines.
- \`project\`: ongoing initiative, decision, motivation specific to this project. Captures the *why* behind code.
- \`reference\`: where to look for X in external systems (Linear, Slack, dashboards).

Output ONLY a JSON object: {"proposals": [{"name": "...", "type": "...", "description": "...", "body": "...", "rationale": "..."}]}.

Rules:
- Pick at most ${MAX_PROPOSALS_PER_RUN} proposals.
- Each \`name\` is short kebab-case (e.g. "no-trailing-summaries", "prefers-pnpm").
- Each \`description\` is one line ≤150 chars — what shows up in MEMORY.md.
- For \`feedback\` and \`project\` types, the \`body\` MUST follow:
  Lead with the rule/fact.\n\n**Why:** <the motivation>.\n\n**How to apply:** <when/where this kicks in>.
- For \`user\` and \`reference\` types, plain prose body is fine.
- \`rationale\` is one short sentence explaining WHY this is worth saving (the signal you keyed on).
- Return {"proposals": []} when the turn has nothing memorable. Routine bug-fixes, code reads, and yes/no exchanges produce nothing. Demand a real signal: explicit preference, validated approach, project-context disclosure, external-system pointer.
- DO NOT save code patterns, file paths, debugging recipes, or anything derivable from the code itself.
- DO NOT save ephemeral task state — the task tracker handles that.`

const SELECTOR_SYSTEM = `You filter a memory catalog down to the entries relevant to a given developer request.

Rules:
- Output ONLY a JSON object: {"names": ["<entry-name>", ...]}. No prose, no markdown, no code fence.
- Pick at most ${MAX_SELECTED_ENTRIES} entries.
- An entry is relevant when:
  * It's a \`user\` entry (developer profile — almost always include).
  * It's a \`feedback\` entry whose rule applies to the kind of work in the request.
  * It's a \`project\` entry whose context is in the same area as the request.
  * It's a \`reference\` entry pointing to a system the request would naturally consult.
- Skip entries that are clearly off-topic. When in doubt INCLUDE — false negatives lose useful context; false positives just cost a few tokens.
- When two entries cover the same topic, prefer the more recent one (lower age = fresher). Old entries can still be relevant — don't drop based on age alone — but on tie, recent wins.
- Use the entry name verbatim. Do not invent names.`

const COMPACT_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your detailed summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing.

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`

const WEBFETCH_SYSTEM = 'You answer questions about web page content. Be precise and concise. '
  + 'If the content does not answer the question, say so plainly instead of guessing — '
  + 'the developer needs to know the page did not have it.'

const IMPROVER_SYSTEM = `Rewrite user prompts for coding LLM agents.

Return ONLY the improved prompt text. No markdown fences, no preface, no commentary.

Use a compact, high-signal structure that models reliably follow:
Objective, Context, Constraints, Acceptance criteria, and Output expectations.

Rules:
- Do not invent product requirements, files, credentials, dates, or technologies.
- Write the ENTIRE output in the same language as the user's prompt (Portuguese in → Portuguese out, including the section headers). Never switch to English.
- Keep it short and directly actionable.
- If the original prompt is already clear, make only minimal structural improvements.`

// ── Fixtures ───────────────────────────────────────────────────────────────

const EXTRACTOR_TURN_SIGNAL = `## Developer's most recent message
Não gosto da opção de um sub-agente fazer a verificação independente no final. Que seja o próprio agente a verificar, ou nem ter essa opção — e quando existir, que seja decisão minha, não default. No nosso produto quem revê os diffs sou eu, o gate final é humano.

## Agent's response (this turn)
Entendido — removi o contrato obrigatório do Verify do system prompt. A doutrina passa a: auto-verificação pelo próprio agente (um passe limpo de tsc/build/testes fecha o checkpoint) e o sub-agente Verify só corre quando o developer pedir explicitamente. Também retirei o counterweight do modelo que empurrava o Verify. Commit feito e push para main.`

const EXTRACTOR_TURN_NOISE = `## Developer's most recent message
sim, faz

## Agent's response (this turn)
Feito — corrigi o typo em README.md (linha 42, "recieve" → "receive") e fiz commit.`

const MEMORY_CATALOG = [
  ['billing-single-source-of-truth', 'project', 'contabilidade EXCLUSIVA do worker ai-pass-through; IDE só exibe; nunca client-side'],
  ['two-worker-architecture', 'project', 'control-plane (Rust/CORS-free) vs AI data-plane (browser fetch/CORS)'],
  ['local-testing-workflow', 'feedback', 'user gere os próprios emuladores; deploy só no fim; não iniciar emuladores por ele'],
  ['tm-code-product-principles', 'project', 'agente vive no CHAT; dev-only ≠ coding-only; sub-agents ENTREGAM, nunca polling'],
  ['sidecar-fleet-architecture', 'project', 'X-Request-Type → KV sidecar:* (web_search/vision/utility/fim)'],
  ['xterm-webgl-renderer-colors', 'project', 'painel PTY monocromático no WKWebView; fix addon-webgl com fallback'],
  ['world-cup-goal-celebration', 'project', 'burst GOAL! no fim de run bem-sucedido; kill switch FOOTBALL_MODE_ENABLED'],
  ['gemini-via-vertex-google-oauth', 'project', 'Gemini é Vertex não AI Studio: authScheme google_oauth + SA JSON no worker'],
  ['data-plane-gateway-retry', 'project', 'retry só de erros de GATEWAY (text/html não-2xx, 502/503/504), 2x'],
  ['onboarding-one-click-install', 'project', 'Windows install de python/node/git no ToolsStep winget-first'],
  ['user-profile', 'user', 'developer sénior, produto TM Code, comenta em português'],
  ['multi-theme-plan', 'project', 'temas via CSS vars; plano completo, adiado'],
].map(([name, type, desc]) => `- name="${name}" type=${type} → ${desc}`).join('\n')

const SELECTOR_REQUEST = 'O billing está a descontar tokens a dobrar quando o utilizador compra extra usage. Investiga onde está a contabilidade e corrige.'
const SELECTOR_MUST_INCLUDE = 'billing-single-source-of-truth'
const SELECTOR_OFF_TOPIC = ['world-cup-goal-celebration', 'xterm-webgl-renderer-colors', 'onboarding-one-click-install']

// Transcript realista (~6k chars) para a compactação — factos verificáveis.
const COMPACT_TRANSCRIPT = `[user]: O painel de terminal abre mas as cores ANSI não aparecem — está tudo monocromático no build de produção do Mac.

[assistant]: Vou investigar o renderer do xterm no painel PTY.
[tool_call read_file src/components/cmd-mode/TerminalPanel.tsx]
[tool_result: usa Terminal do @xterm/xterm com renderer DOM default, term.open(node), tema passado via tokens.colors.terminal]

O tema está a ser passado. Suspeito do renderer DOM no WKWebView — vou confirmar com um teste local.
[tool_call execute_command yarn tauri dev]
[tool_result: reproduzido — ANSI sem cor no WKWebView; no Chrome as cores aparecem]

Confirmado: o renderer DOM do xterm não aplica os estilos ANSI no WKWebView do Tauri. A solução é o addon WebGL.
[tool_call execute_command yarn add @xterm/addon-webgl]
[tool_result: added @xterm/addon-webgl@0.19.0]

[tool_call edit_file src/components/cmd-mode/TerminalPanel.tsx]
[tool_result: loadAddon(new WebglAddon()) DEPOIS de term.open(), com try/catch e fallback para canvas]

[user]: Atenção que em máquinas antigas o WebGL pode não existir. E não quero regressão no Windows.

[assistant]: Certo — o try/catch já cobre isso: se o WebglAddon lançar (contexto WebGL indisponível), ficamos no renderer canvas. Vou validar.
[tool_call execute_command yarn build]
[tool_result: error TS2345: Argument of type 'WebglAddon' is not assignable — @xterm/xterm 5.x precisa de addon-webgl@0.18]

Erro de versão: o addon 0.19 pede xterm 6. Vou fixar 0.18.
[tool_call execute_command yarn add @xterm/addon-webgl@0.18.0]
[tool_result: ok]
[tool_call execute_command yarn build]
[tool_result: build verde, 0 erros]

Feito: WebGL renderer com fallback, build verde. No Windows o caminho é o mesmo (WKWebView é só Mac; WebView2 no Windows tem WebGL estável).

[user]: Perfeito. Faz commit mas NÃO faças release — a release só depois de eu testar o dmg localmente.`

const COMPACT_MUST_INCLUDE = [
  'TerminalPanel.tsx', 'WebGL', 'WKWebView', '0.18', 'fallback',
]
// A instrução explícita do user tem de sobreviver ao resumo (é o que mais dói perder).
const COMPACT_MUST_INCLUDE_ANY = [['release', 'dmg']]

const WEBFETCH_CONTENT = `# wrangler CLI docs (excerpt)

## wrangler dev
Start a local server for developing your Worker. Uses local mode by default. Port defaults to 8787; override with --port.

## wrangler kv key put
Writes a single key/value pair to a KV namespace. Usage: wrangler kv key put <key> <value> --namespace-id=<id>. Add --remote to write to the production namespace instead of the local simulation.

## wrangler deploy
Deploys your Worker to Cloudflare. Reads configuration from wrangler.toml or wrangler.jsonc in the current directory, or pass --config <path>.`

const WEBFETCH_Q_PRESENT = 'Como escrevo uma chave no KV de produção (não local)?'
const WEBFETCH_A_EXPECT = ['--remote']
const WEBFETCH_Q_ABSENT = 'Qual é o limite de tamanho máximo de um valor no KV?'

const IMPROVER_INPUT = 'faz ai uma pagina de login mas tipo moderna, com google e tal, e que funcione no dark mode do site que ja temos'

// ── Casos ──────────────────────────────────────────────────────────────────
// check(content) → lista de falhas (vazia = passou). Content já vem sem <think>.

function parseJsonLoose(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try { return { obj: JSON.parse(trimmed), fenced: trimmed !== text.trim() } } catch { return { obj: null, fenced: false } }
}

const CASES = [
  {
    key: 'mem-extract-signal',
    requestType: 'memory-extractor',
    body: {
      messages: [
        { role: 'system', content: EXTRACTOR_SYSTEM },
        { role: 'user', content: EXTRACTOR_TURN_SIGNAL },
      ],
      temperature: 0, max_tokens: 1600, response_format: { type: 'json_object' },
    },
    check(content) {
      const fails = []
      const { obj } = parseJsonLoose(content)
      if (!obj) return ['json inválido']
      if (!Array.isArray(obj.proposals)) return ['sem array proposals']
      if (obj.proposals.length === 0) fails.push('turno com sinal claro → 0 propostas')
      if (obj.proposals.length > MAX_PROPOSALS_PER_RUN) fails.push(`>${MAX_PROPOSALS_PER_RUN} propostas`)
      for (const p of obj.proposals) {
        if (!p.name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.name)) fails.push(`name não kebab-case: ${p.name}`)
        if (!['user', 'feedback', 'project', 'reference'].includes(p.type)) fails.push(`type fora da taxonomia: ${p.type}`)
        if ((p.type === 'feedback' || p.type === 'project') && !(p.body || '').includes('**Why:**')) fails.push('body sem **Why:**')
      }
      return fails
    },
  },
  {
    key: 'mem-extract-noise',
    requestType: 'memory-extractor',
    body: {
      messages: [
        { role: 'system', content: EXTRACTOR_SYSTEM },
        { role: 'user', content: EXTRACTOR_TURN_NOISE },
      ],
      temperature: 0, max_tokens: 1600, response_format: { type: 'json_object' },
    },
    check(content) {
      const { obj } = parseJsonLoose(content)
      if (!obj || !Array.isArray(obj.proposals)) return ['json inválido ou sem proposals']
      return obj.proposals.length === 0 ? [] : [`turno banal → ${obj.proposals.length} propostas (esperado 0)`]
    },
  },
  {
    key: 'mem-select',
    requestType: 'memory-selector',
    body: {
      messages: [
        { role: 'system', content: SELECTOR_SYSTEM },
        { role: 'user', content: `Developer request:\n${SELECTOR_REQUEST}\n\nMemory catalog (12 entries):\n${MEMORY_CATALOG}` },
      ],
      temperature: 0, max_tokens: 800, response_format: { type: 'json_object' },
    },
    check(content) {
      const fails = []
      const { obj } = parseJsonLoose(content)
      if (!obj || !Array.isArray(obj.names)) return ['json inválido ou sem names']
      const catalog = MEMORY_CATALOG.match(/name="([^"]+)"/g).map(s => s.slice(6, -1))
      for (const n of obj.names) if (!catalog.includes(n)) fails.push(`nome inventado: ${n}`)
      if (!obj.names.includes(SELECTOR_MUST_INCLUDE)) fails.push(`faltou ${SELECTOR_MUST_INCLUDE}`)
      const off = obj.names.filter(n => SELECTOR_OFF_TOPIC.includes(n))
      if (off.length >= 2) fails.push(`ruído off-topic: ${off.join(',')}`)
      return fails
    },
  },
  {
    key: 'compact',
    requestType: 'summarize',
    body: {
      messages: [
        { role: 'user', content: `${COMPACT_TRANSCRIPT}\n\n---\n\n${COMPACT_PROMPT}` },
      ],
      temperature: 0, max_tokens: 4000,
    },
    check(content) {
      const fails = []
      if (!/<summary>[\s\S]*<\/summary>/.test(content)) fails.push('sem bloco <summary> fechado')
      for (const k of COMPACT_MUST_INCLUDE) if (!content.includes(k)) fails.push(`facto perdido: ${k}`)
      for (const group of COMPACT_MUST_INCLUDE_ANY) {
        if (!group.some(k => content.toLowerCase().includes(k))) fails.push(`instrução do user perdida: ${group.join('|')}`)
      }
      if (/\[tool_call/.test(content.replace(/<analysis>[\s\S]*?<\/analysis>/g, '')) === false && /"tool_calls"/.test(content)) fails.push('tentou tool call')
      return fails
    },
  },
  {
    key: 'webfetch-qa',
    requestType: 'summarize',
    body: {
      messages: [
        { role: 'system', content: WEBFETCH_SYSTEM },
        { role: 'user', content: `Web page content:\n\n${WEBFETCH_CONTENT}\n\nQuestion: ${WEBFETCH_Q_PRESENT}` },
      ],
      temperature: 0, max_tokens: 600,
    },
    check(content) {
      return WEBFETCH_A_EXPECT.every(k => content.includes(k)) ? [] : ['não encontrou a resposta (--remote)']
    },
  },
  {
    key: 'webfetch-absent',
    requestType: 'summarize',
    body: {
      messages: [
        { role: 'system', content: WEBFETCH_SYSTEM },
        { role: 'user', content: `Web page content:\n\n${WEBFETCH_CONTENT}\n\nQuestion: ${WEBFETCH_Q_ABSENT}` },
      ],
      temperature: 0, max_tokens: 600,
    },
    check(content) {
      // Não pode inventar um número; tem de dizer que a página não o tem.
      if (/\b(25\s?MiB|25\s?MB|1\s?MB|10\s?MB|512\s?KB)\b/i.test(content)) return ['alucinou um limite']
      return /(não|not|doesn't|does not|no information|não menciona|não contém|não responde|não indica)/i.test(content) ? [] : ['não admitiu ausência']
    },
  },
  {
    key: 'prompt-improve',
    requestType: 'utility',
    body: {
      messages: [
        { role: 'system', content: IMPROVER_SYSTEM },
        { role: 'user', content: IMPROVER_INPUT },
      ],
      temperature: 0.1, max_tokens: 350,
    },
    check(content) {
      const fails = []
      if (content.startsWith('```')) fails.push('markdown fence')
      if (/^(Here|Aqui está|Claro|Sure|Improved prompt)/i.test(content)) fails.push('preâmbulo')
      if (!/(login|autentica)/i.test(content)) fails.push('perdeu o objetivo')
      if (!/(google)/i.test(content)) fails.push('perdeu o requisito Google')
      // "Keep the user's language" — input PT tem de sair PT.
      if (!/(página|utilizador|modo escuro|escuro|sessão|deve|criar|crie|existente)/i.test(content)) fails.push('mudou de língua')
      return fails
    },
  },
]

// ── Execução ───────────────────────────────────────────────────────────────

function stripThink(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

async function callModel(variant, testCase) {
  const started = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: variant.model, stream: false, ...testCase.body, ...variant.extraBody }),
      signal: ac.signal,
    })
    const latencyMs = Date.now() - started
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, latencyMs, error: `HTTP ${res.status}: ${text.slice(0, 160)}` }
    }
    const data = await res.json()
    const msg = data.choices?.[0]?.message ?? {}
    const rawContent = msg.content ?? ''
    const leak = /<think>/.test(rawContent)
    const content = stripThink(rawContent)
    const fails = testCase.check(content)
    return {
      ok: true, latencyMs, leak, fails,
      usage: data.usage ?? {},
      reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? (msg.reasoning_content ? -1 : 0),
      servedModel: data.model,
    }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: e.name === 'AbortError' ? `TIMEOUT ${TIMEOUT_MS}ms` : String(e).slice(0, 160) }
  } finally {
    clearTimeout(timer)
  }
}

function pct(arr, p) {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

const results = []
for (const variant of VARIANTS) {
  console.log(`\n━━ ${variant.key} (${variant.model}) ━━`)
  for (const testCase of CASES) {
    for (let rep = 0; rep < REPS; rep++) {
      const r = await callModel(variant, testCase)
      results.push({ variant: variant.key, case: testCase.key, rep, ...r })
      const status = !r.ok ? `ERR ${r.error}` : r.fails.length === 0 ? 'ok' : `FAIL [${r.fails.join('; ')}]`
      console.log(`  ${testCase.key.padEnd(20)} #${rep} ${String(r.latencyMs).padStart(6)}ms ${r.leak ? 'LEAK ' : ''}${r.reasoningTokens ? `think:${r.reasoningTokens} ` : ''}${status}`)
    }
  }
}

// ── Sumário ────────────────────────────────────────────────────────────────
console.log('\n══ SUMÁRIO ══')
console.log('variant          | calls | válidas | erros | leaks | lat p50 | lat p95 | out-tokens médios')
for (const variant of VARIANTS) {
  const rs = results.filter(r => r.variant === variant.key)
  const okRs = rs.filter(r => r.ok)
  const valid = okRs.filter(r => r.fails.length === 0).length
  const lats = okRs.map(r => r.latencyMs)
  const outTok = okRs.map(r => r.usage?.completion_tokens ?? 0)
  console.log(
    `${variant.key.padEnd(16)} | ${String(rs.length).padStart(5)} | ${String(valid).padStart(7)} | ${String(rs.length - okRs.length).padStart(5)} | ${String(okRs.filter(r => r.leak).length).padStart(5)} | ${String(pct(lats, 0.5)).padStart(6)}ms | ${String(pct(lats, 0.95)).padStart(6)}ms | ${outTok.length ? Math.round(outTok.reduce((a, b) => a + b, 0) / outTok.length) : 0}`,
  )
}
console.log('\nPor caso (válidas/total):')
for (const testCase of CASES) {
  const line = VARIANTS.map(v => {
    const rs = results.filter(r => r.variant === v.key && r.case === testCase.key)
    const valid = rs.filter(r => r.ok && r.fails.length === 0).length
    return `${v.key}=${valid}/${rs.length}`
  }).join('  ')
  console.log(`  ${testCase.key.padEnd(20)} ${line}`)
}
