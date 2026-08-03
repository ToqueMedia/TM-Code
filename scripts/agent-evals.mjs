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
import { existsSync, readFileSync, rmSync } from 'node:fs'
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

const cases = JSON.parse(
  readFileSync(path.join(ROOT, 'evals/cases.json'), 'utf8'),
).filter((c) => !only || c.id === only)

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
  await ensureService('vite', VITE_PORT, 'yarn', ['dev'], { VITE_AI_WORKER_URL: WORKER_URL })
}

function runCase(c) {
  const project = path.join(ROOT, c.project)
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
      const ok = missingText.length === 0 && missingFiles.length === 0
      resolve({
        c,
        ok,
        durationMs,
        text,
        diag: result.diag,
        reason: ok
          ? ''
          : `em falta: ${[...missingText.map((m) => `texto /${m}/`), ...missingFiles.map((f) => `ficheiro ${f}`)].join(' | ')}`,
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
        ? `[evals] ✅ ${c.id} em ${(r.durationMs / 1000).toFixed(1)}s — "${(r.text ?? '').slice(0, 100)}"`
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
process.exit(passed === results.length ? 0 : 1)
