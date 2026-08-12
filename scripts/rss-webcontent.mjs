/**
 * RSS do WebContent DA IDE — e só dele.
 *
 * SUBSTITUI o comando que andava no handoff, que estava ERRADO:
 *
 *     ps -o rss= -p $(pgrep -f "WebKit.WebContent" | head -1)   ← NÃO
 *
 * No macOS os WebContent são serviços XPC e ficam TODOS com ppid=1 (launchd),
 * portanto não há laço de parentesco com a app e o `head -1` apanha um
 * qualquer. Na máquina do developer apanhava um processo de 8,7 GB que era de
 * OUTRA aplicação — ou seja, a bissecção original pode ter medido ruído.
 *
 * O WebContent da IDE identifica-se por ter aberto o cache dela:
 * `~/Library/Caches/toquemedia-studio/WebKit/`. É esse o critério aqui.
 *
 *     node scripts/rss-webcontent.mjs           # uma leitura
 *     node scripts/rss-webcontent.mjs 300 2     # 300 amostras, 2s de intervalo
 *
 * Para a bissecção: uma leitura em repouso, depois abrir projecto, depois um
 * run só de leituras, depois um run com diffs — comparando os patamares. O que
 * a fuga dos diffs faz é o patamar NÃO descer depois do run.
 *
 * Para medir o mecanismo em vez do sintoma (sem ruído do WebKit, do Monaco e
 * dos buffers de tool results), usar antes `heap-diff-retention.mjs`.
 */
import { execSync } from 'node:child_process'

const AMOSTRAS = Number(process.argv[2] ?? 1)
const INTERVALO_S = Number(process.argv[3] ?? 2)

const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8' }) } catch { return '' } }

function idePids() {
  const pids = sh('pgrep -f "WebKit.WebContent" 2>/dev/null || true').split('\n').filter(Boolean)
  return pids.filter(p => Number(sh(
    `lsof -nP -p ${p} 2>/dev/null | grep -c "Caches/toquemedia-studio/WebKit" || true`,
  ).trim()) > 0)
}

const alvos = idePids()
if (alvos.length === 0) {
  console.log('Nenhum WebContent da IDE encontrado — a app está a correr?')
  process.exit(0)
}
console.log(`WebContent da IDE: ${alvos.join(', ')}${alvos.length > 1 ? '  (várias janelas)' : ''}\n`)

const base = {}
for (let i = 0; i < AMOSTRAS; i++) {
  const linha = alvos.map(p => {
    const kb = Number(sh(`ps -o rss= -p ${p} 2>/dev/null || true`).trim() || 0)
    if (!kb) return `${p}=morto`
    const mb = Math.round(kb / 1024)
    base[p] ??= mb
    return `${p}=${mb}MB (${mb - base[p] >= 0 ? '+' : ''}${mb - base[p]})`
  }).join('  ')
  console.log(`${new Date().toTimeString().slice(0, 8)}  ${linha}`)
  if (i < AMOSTRAS - 1) await new Promise(r => setTimeout(r, INTERVALO_S * 1000))
}
