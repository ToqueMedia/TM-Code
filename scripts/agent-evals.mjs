#!/usr/bin/env node
/**
 * Evals do agente sobre o runner headless (task F1-7; ver
 * docs/DESIGN-HEADLESS-RUNNER.md e evals/README.md).
 *
 * Cada caso arranca o binário de dev (`src-tauri/target/debug/...`) em modo
 * runner (TM_RUN_*), lê o NDJSON do stdout e valida o `result` contra as
 * expectativas do caso (regex no texto e/ou ficheiros criados). É a régua
 * mecânica do "o agente ficou melhor ou pior?" — corre em série, com custo
 * REAL de tokens (ver README).
 *
 * Uso:
 *   node scripts/agent-evals.mjs             # todos os casos
 *   node scripts/agent-evals.mjs --only id   # um caso
 *   EVALS_AI_WORKER_URL=https://…            # rota AI para o vite que o
 *                                            # script arranca (default: prod)
 *
 * Pré-requisitos: binário de dev construído (cargo build em src-tauri) e
 * sessão TM Code autenticada nesta máquina (o runner usa-a). Se já houver um
 * vite em :1420 (p.ex. yarn tauri:dev:all), é REUTILIZADO — e nesse caso a
 * rota AI é a desse processo, não a do EVALS_AI_WORKER_URL.
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'src-tauri/target/debug/toquemedia-studio')
const VITE_PORT = 1420
const AI_WORKER_PORT = 8788
// Default: o worker LOCAL (o caminho provado pelos smoke da P6 — o worker de
// produção respondeu 401 ao token da sessão de dev na 1ª corrida dos evals).
const WORKER_URL =
  process.env.EVALS_AI_WORKER_URL || `http://localhost:${AI_WORKER_PORT}`

const only = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? process.argv[i + 1] : null
})()
const onlyIds = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : null

const cases = JSON.parse(
  readFileSync(path.join(ROOT, 'evals/cases.json'), 'utf8'),
).filter((c) => (onlyIds ? onlyIds.includes(c.id) : !c.benchmark))
// `benchmark: true` fica FORA da suite por defeito. Não é um portão: é uma
// régua de medição cuja taxa de falha é uma propriedade do agente, não uma
// regressão. `ui-design-tokens` falha ~37% das vezes com ou sem as secções de
// design system (n=20 por braço, p=1.00) — pô-lo no portão de merge tornava o
// portão ruído. Corre-o de propósito com `--only ui-design-tokens`.

if (cases.length === 0) {
  console.error(`[evals] nenhum caso${only ? ` com id "${only}"` : ''}.`)
  process.exit(2)
}
if (!existsSync(BIN)) {
  console.error(`[evals] binário não encontrado: ${BIN}\n  → corre primeiro: cd src-tauri && cargo build`)
  process.exit(2)
}

async function portAlive(port) {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

const spawned = []
async function ensureService(name, port, cmd, args, env) {
  if (await portAlive(port)) {
    console.log(`[evals] ${name} já vivo em :${port} — reutilizado.`)
    return
  }
  console.log(`[evals] a arrancar ${name} em :${port}…`)
  const proc = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore' })
  spawned.push(proc)
  for (let i = 0; i < 120; i++) {
    if (await portAlive(port)) return
    await sleep(500)
  }
  throw new Error(`${name} não respondeu em :${port} dentro de 60s`)
}

async function ensureStack() {
  // O wrangler local primeiro (o vite só precisa do URL, mas o preflight do
  // runner precisa do worker a ouvir). Se EVALS_AI_WORKER_URL for remoto,
  // o worker local não é arrancado.
  if (WORKER_URL.includes(`localhost:${AI_WORKER_PORT}`)) {
    await ensureService('ai-worker', AI_WORKER_PORT, 'yarn', ['dev:ai-worker'], {})
  }
  // `VITE_AUTOCOMPACT_PCT` encurta o limiar de compactação (só encurta —
  // ver contextWindow.ts). É o que torna um caso de compactação viável: sem
  // ele seria preciso encher 131K de janela, e a compactação só se via em
  // sessões reais de horas.
  //
  // ATENÇÃO: é uma env de BUILD do vite. Um vite JÁ VIVO em :1420 foi
  // arrancado sem ela e não a ganha — por isso o aviso abaixo, em vez de um
  // caso que passa a verde sem nunca ter compactado.
  const pctOverride = process.env.EVALS_AUTOCOMPACT_PCT
  const viteJaVivo = await portAlive(VITE_PORT)
  if (pctOverride && viteJaVivo) {
    console.log(
      `[evals] AVISO: EVALS_AUTOCOMPACT_PCT=${pctOverride} pedido, mas o vite de :${VITE_PORT} ` +
      `já estava a correr sem ele — o limiar NÃO foi encurtado. Fecha o vite e repete.`,
    )
  }
  await ensureService('vite', VITE_PORT, 'yarn', ['dev'], {
    VITE_AI_WORKER_URL: WORKER_URL,
    ...(pctOverride ? { VITE_AUTOCOMPACT_PCT: pctOverride } : {}),
  })
}

function runCase(c) {
  // HERMÉTICO (03-08): cada caso corre numa CÓPIA fresca da fixture em
  // temp-dir. Correr no lugar contaminava as corridas seguintes — o TM Code
  // persiste sessões/snapshots de fila/locks por projecto (state-dir keyed
  // ao path), e restos de um run morto interferiam de forma
  // não-determinística com o boot do seguinte (a flakiness inteira da 1ª
  // bateria). Path novo = estado app-managed virgem.
  const fixture = path.join(ROOT, c.project)
  const project = mkdtempSync(path.join(tmpdir(), `tm-eval-${c.id}-`))
  cpSync(fixture, project, { recursive: true })
  for (const f of c.cleanupFiles ?? []) {
    rmSync(path.join(project, f), { force: true })
  }
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(BIN, [], {
      env: {
        ...process.env,
        TM_RUN_TASK: c.task,
        TM_RUN_PROJECT: project,
        TM_RUN_YOLO: c.yolo === false ? '' : '1',
      },
    })
    let buf = ''
    const events = []
    let result = null
    const timeoutMs = (c.timeoutSec ?? 180) * 1000
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      buf += d.toString()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('{')) continue
        try {
          const evt = JSON.parse(line)
          events.push(evt)
          if (evt.type === 'result') result = evt
        } catch {
          /* linha não-JSON no meio do stdout — ignorada */
        }
      }
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      const durationMs = Date.now() - started
      if (!result) {
        const tail = events.slice(-3).map(e => JSON.stringify(e)).join('\n           ')
        return resolve({
          c,
          ok: false,
          durationMs,
          reason: `exit ${code ?? 'kill'} sem result (${events.length} eventos)\n           últimos: ${tail || '(nenhum)'}`,
          events,
        })
      }
      if (result.subtype !== 'success') {
        return resolve({ c, ok: false, durationMs, reason: `result error: ${result.error}`, events })
      }
      const text = result.text ?? ''
      const missingText = (c.expect ?? []).filter((rx) => !new RegExp(rx, 'i').test(text))
      const missingFiles = (c.expectFiles ?? []).filter((f) => !existsSync(path.join(project, f)))
      // Asserções sobre o CONTEÚDO gerado — a única forma de medir QUALIDADE
      // em vez de "o ficheiro existe". `expectFileContains` prova que a regra
      // chegou (ex.: a linha de base de UI manda tratar o estado vazio);
      // `refuteFileContains` apanha os tiques que a secção de gosto nomeia.
      const readOut = (f) => {
        try { return readFileSync(path.join(project, f), 'utf8') } catch { return '' }
      }
      const missingContent = []
      for (const [file, patterns] of Object.entries(c.expectFileContains ?? {})) {
        const body = readOut(file)
        for (const rx of patterns) {
          if (!new RegExp(rx, 'i').test(body)) missingContent.push(`${file} sem /${rx}/`)
        }
      }
      const forbiddenContent = []
      for (const [file, patterns] of Object.entries(c.refuteFileContains ?? {})) {
        const body = readOut(file)
        for (const rx of patterns) {
          if (new RegExp(rx, 'i').test(body)) forbiddenContent.push(`${file} com /${rx}/`)
        }
      }
      // `expectCompaction`: o caso EXIGE que a compactação tenha corrido. Sem
      // isto, um caso de compactação passa a verde quando ela nunca disparou —
      // que é o falso positivo que este harness já produziu duas vezes.
      const comp = result.compaction ?? {}
      const missingCompaction =
        c.expectCompaction && !(comp.boundaries > 0)
          ? [`compactação exigida mas boundaries=${comp.boundaries ?? 0}`]
          : []
      const ok = missingText.length === 0 && missingFiles.length === 0 &&
        missingContent.length === 0 && forbiddenContent.length === 0 &&
        missingCompaction.length === 0
      // A cópia temp só é limpa em SUCESSO — num falhanço fica no disco para
      // autópsia (o path segue no reason).
      if (ok) rmSync(project, { recursive: true, force: true })
      resolve({
        c,
        ok,
        durationMs,
        text,
        cost: result.cost ?? null,
        compaction: result.compaction ?? null,
        diag: result.diag,
        reason: ok
          ? ''
          : `em falta: ${[...missingText.map((m) => `texto /${m}/`), ...missingFiles.map((f) => `ficheiro ${f}`), ...missingContent, ...missingCompaction, ...forbiddenContent.map((f) => `PROIBIDO ${f}`)].join(' | ')} (autópsia: ${project})`,
      })
    })
  })
}

const results = []
try {
  await ensureStack()
  for (const c of cases) {
    console.log(`\n[evals] ▶ ${c.id} — "${c.task.slice(0, 60)}…"`)
    const r = await runCase(c)
    results.push(r)
    console.log(
      r.ok
        ? `[evals] ✅ ${c.id} em ${(r.durationMs / 1000).toFixed(1)}s — "${(r.text ?? '').slice(0, 100)}"` +
          (r.cost ? `\n         custo: ${r.cost.requests} pedidos, in ${r.cost.inputTokens} (cache ${r.cost.cacheReadInputTokens}), out ${r.cost.outputTokens}, aux/pedido ${r.cost.auxiliaryContextTokensMax}` : '') +
          (r.compaction ? `\n         contexto: ${r.compaction.boundaries} compactação(ões), ${r.compaction.budgetMarkers} marcos de orçamento, ${r.compaction.rereads} RELEITURAS de ${r.compaction.distinctFilesRead} ficheiros` : '')
        : `[evals] ❌ ${c.id} em ${(r.durationMs / 1000).toFixed(1)}s — ${r.reason}\n` +
          `         text: "${(r.text ?? '').slice(0, 300)}"\n` +
          `         diag: ${JSON.stringify(r.diag ?? null)}`,
    )
  }
} finally {
  for (const proc of spawned) proc.kill('SIGTERM')
}

const passed = results.filter((r) => r.ok).length
console.log(`\n[evals] ─── ${passed}/${results.length} casos verdes ───`)
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.c.id.padEnd(20)} ${(r.durationMs / 1000).toFixed(1)}s${r.ok ? '' : `  ${r.reason}`}`)
}
// TOTAIS de custo — a régua do "ganhou ou perdeu" quando se mexe no prompt.
// Verde sem isto só diz que não partiu. `--json <ficheiro>` grava para poder
// comparar duas corridas (baseline vs mudança) sem depender do olho.
const totals = results.reduce((acc, r) => {
  if (!r.cost) return acc
  acc.requests += r.cost.requests
  acc.inputTokens += r.cost.inputTokens
  acc.outputTokens += r.cost.outputTokens
  acc.cacheReadInputTokens += r.cost.cacheReadInputTokens
  acc.auxPerRequestMax = Math.max(acc.auxPerRequestMax, r.cost.auxiliaryContextTokensMax)
  return acc
}, { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, auxPerRequestMax: 0 })
console.log(
  `  ── custo: ${totals.requests} pedidos | in ${totals.inputTokens.toLocaleString()} ` +
  `(cache ${totals.cacheReadInputTokens.toLocaleString()}) | out ${totals.outputTokens.toLocaleString()} ` +
  `| aux/pedido ${totals.auxPerRequestMax}`,
)
const jsonIdx = process.argv.indexOf('--json')
if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) {
  writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ totals, cases: results.map(r => ({ id: r.c.id, ok: r.ok, durationMs: r.durationMs, cost: r.cost })) }, null, 2))
  console.log(`  ── gravado em ${process.argv[jsonIdx + 1]}`)
}
process.exit(passed === results.length ? 0 : 1)
