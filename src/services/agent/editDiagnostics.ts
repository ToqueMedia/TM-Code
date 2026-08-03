/**
 * Diagnósticos NOVOS depois de um edit, entregues entre turnos.
 *
 * PORQUÊ: em sete sessões na mesma tarefa (momenu-fact, 2026-07-31) o modelo
 * identificou as DUAS call-sites de um método — chegou a nomeá-las pelo número
 * de linha — e emitiu UM só `edit_file` em seis delas, deixando a segunda a
 * chamar um método apagado. Seis redacções de prompt diferentes ao longo do
 * dia, incluindo uma instrução falsa e a sua correção; comportamento idêntico.
 * Prosa não fecha buracos de correctness — este repo já opera assim no
 * read-before-write, no planMode e no selo do `.env`.
 *
 * PORTE de `cli-vaz/services/diagnosticTracking.ts` + `utils/attachments.ts`:
 * baseline → delta → entrega por attachment inter-turno, sem tool que o modelo
 * tenha de se lembrar de chamar.
 *
 * ── A FONTE: `tsc`, não o worker do Monaco ──────────────────────────────
 * A primeira versão lia do `TypeScriptLspService` (worker TS do Monaco). Foi a
 * produção que a matou: numa run real entregou **5 erros de "implicit any"
 * que não existem** — o `tsc --noEmit` do mesmo projeto, com o mesmo
 * `strict: true`, reporta ZERO. O worker é lazy por decisão explícita
 * (carregar o projeto todo congela o editor) e resolve cross-file
 * pré-carregando só os imports directos; fora disso os tipos caem para `any`
 * e ele inventa.
 *
 * O custo real não era o ruído. Se `apiClient` é `any` aos olhos do worker,
 * apagar `seedStorefrontTemplate()` do `ApiClient.ts` **não produz TS2339
 * nenhum** — chamar qualquer coisa num `any` é legal. A mesma resolução
 * preguiçosa que fabricava os erros falsos apagava o verdadeiro: o guarda não
 * conseguia detectar o defeito para que foi construído.
 *
 * `tsc --noEmit --incremental` medido no mesmo projeto: **9,5s a frio, 1,7s em
 * regime**. Num turn boundary, ao lado de uma chamada ao modelo, é invisível —
 * e é exactamente o que o developer vê no terminal dele.
 *
 * NOTA para quem mexer no editor: o Problems panel (`problemsStore`) ainda lê
 * do worker do Monaco e sofre dos MESMOS fantasmas. Não é o mesmo problema que
 * este módulo resolve — lá o requisito é latência interactiva, e a resposta
 * certa seria um LSP real por stdio.
 */
import { invoke } from '@/utils/invokeMetrics'
import { logger } from '@/utils/logger'

export interface EditDiagnostic {
  file: string
  line: number
  column: number
  message: string
  severity: 'error' | 'warning'
  code: number
}

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
}

/** Teto do texto entregue: o aviso protege contexto, não o gasta. */
const MAX_SHOWN = 12
/** `tsc` a frio chega aos ~10s; acima disto algo está errado e desiste-se. */
const TIMEOUT_SECS = 90

/** Assinatura de um diagnóstico — SEM a posição.
 *
 *  Paridade com o `areDiagnosticsEqual` do original seria incluir o range, e
 *  cheguei a fazê-lo. A produção mostrou o custo: os edits removeram 4 linhas
 *  (511 → 507) e CINCO erros pré-existentes deslocaram-se, reaparecendo todos
 *  como "novos". O modelo gastou seis turnos a perceber que era deslocamento.
 *  O original pode dar-se ao luxo da posição porque lê de um LSP exacto sobre
 *  um projeto sem erros — não há nada para deslocar. Aqui a baseline real de
 *  um projeto tem erros, e a posição transforma cada edição que muda o número
 *  de linhas numa cascata de falsos positivos.
 *
 *  Custo aceite: dois erros IDÊNTICOS (mesmo código e mensagem) em ficheiros
 *  diferentes continuam distintos — o ficheiro entra na chave; dois idênticos
 *  no MESMO ficheiro colapsam num só. */
function signature(d: EditDiagnostic): string {
  return `${d.file}::${d.code}::${d.message}`
}

/** Baseline do PROJECTO (não por ficheiro — o `tsc` vê tudo de uma vez). */
let baseline: Set<string> | null = null
/** Corrida de baseline em voo, arrancada no início do run. */
let baselinePending: Promise<void> | null = null
/** Houve edição desde a última recolha? Sem isto pagava-se `tsc` em turnos
 *  que só leram ficheiros, onde nada pode ter mudado. */
let dirty = false
/** Projecto sem TypeScript (ou sem `tsc` acessível): desiste-se em silêncio
 *  para o resto do run em vez de pagar timeout a cada turno. */
let disabled = false
/** Houve escrita ANTES de a baseline terminar? A baseline corre em background
 *  e lê do DISCO; se um edit aterrar a meio, ela mede o ficheiro já alterado e
 *  o delta sai vazio — guarda mudo, sem falhar nada. Nesse caso descarta-se o
 *  relatório desse turno e adopta-se o estado actual como nova baseline. */
let editedBeforeBaseline = false
/** Onde o `tsc` guarda o `.tsbuildinfo`. Fora do projecto: sem isto escrevia
 *  um ficheiro de ~0,5 MB na raiz do developer só por termos verificado tipos. */
let buildInfoPath = ''

/**
 * Arranca a baseline do run, sem bloquear.
 *
 * Chamado no início de cada run. Corre em paralelo com a fase de exploração
 * do agente — que nas sessões medidas levou 5+ turnos antes do primeiro edit,
 * mais do que suficiente para um `tsc` frio de ~10s. Se ainda não estiver
 * pronta quando o primeiro edit aterrar, `collectNewDiagnostics` espera por
 * ela: é preferível um turn boundary mais lento a um relatório inventado.
 */
export function startDiagnosticsBaseline(projectRoot: string, stateDir?: string): Promise<void> {
  resetEditDiagnostics()
  if (!projectRoot) return Promise.resolve()
  buildInfoPath = stateDir ? `${stateDir.replace(/[/\\]+$/, '')}/tsc-agent.tsbuildinfo` : ''
  logger.info('diagnostics', `baseline: a arrancar em ${projectRoot}` + (buildInfoPath ? ` (tsbuildinfo em ${buildInfoPath})` : ' (SEM state dir — tsbuildinfo vai para o projeto)'))
  const t0 = Date.now()
  baselinePending = (async () => {
    const found = await runTsc(projectRoot)
    if (found === null) {
      disabled = true
      logger.warn('diagnostics', `baseline: DESLIGADO — tsc indisponível neste projeto (${Date.now() - t0}ms)`)
      return
    }
    baseline = new Set(found.map(signature))
    logger.info('diagnostics', `baseline: ${found.length} diagnóstico(s) pré-existentes em ${Date.now() - t0}ms`)
  })().catch(() => {
    disabled = true
    logger.warn('diagnostics', 'baseline: DESLIGADO — exceção inesperada')
  })
  // Devolve a promessa para quem QUISER esperar (testes, ou um caller que
  // prefira pagar o arranque). O agentService não espera de propósito: a
  // passagem fria corre em paralelo com a exploração do agente.
  return baselinePending
}

/**
 * Marca que uma escrita foi APLICADA neste turno.
 *
 * Chamado depois da aprovação, não antes: com a baseline a ser do projecto
 * inteiro e tirada no arranque do run, não há nada a medir por ficheiro — e um
 * diff REJEITADO não muda o disco, portanto pagar `tsc` por ele era 1,7s a
 * zero. Barato de propósito: o custo é uma passagem por turn boundary.
 */
export function markProjectEdited(): void {
  dirty = true
  if (baseline === null) editedBeforeBaseline = true
}

/**
 * Diagnósticos que não existiam na baseline. A baseline AVANÇA para o estado
 * actual (paridade com o original), portanto um erro não corrigido não se
 * repete no turno seguinte.
 */
export async function collectNewDiagnostics(projectRoot: string): Promise<EditDiagnostic[]> {
  // Um mecanismo em que "funcionou na perfeição" e "nunca arrancou" produzem
  // o MESMO silêncio é indistinguível de estar partido — foi exactamente o que
  // aconteceu na primeira run com tsc. Cada saída diz porquê.
  if (disabled) return []
  if (!projectRoot) { logger.warn('diagnostics', 'recolha: sem raiz de projeto'); return [] }
  if (!dirty) return []
  dirty = false
  if (baselinePending) { try { await baselinePending } catch { /* disabled */ } }
  if (disabled) return []
  if (baseline === null) { logger.warn('diagnostics', 'recolha: sem baseline — nada a comparar'); return [] }

  const t0 = Date.now()
  const now = await runTsc(projectRoot)
  if (now === null) {
    disabled = true
    logger.warn('diagnostics', 'recolha: DESLIGADO — tsc deixou de responder')
    return []
  }

  const before = baseline
  baseline = new Set(now.map(signature))
  // Baseline contaminada: houve escrita antes de ela terminar, portanto pode
  // já conter o efeito dessa escrita. Adopta-se o estado actual e não se
  // reporta nada — um relatório vazio é honesto; um delta contra uma baseline
  // suja seria silêncio disfarçado de "está tudo bem".
  if (editedBeforeBaseline) {
    editedBeforeBaseline = false
    logger.info('diagnostics', `recolha: baseline contaminada (escrita antes de fechar) — turno descartado, ${now.length} diagnóstico(s) adoptados como nova baseline`)
    return []
  }
  const fresh = now.filter(d => !before.has(signature(d)))
  logger.info('diagnostics', `recolha: ${fresh.length} novo(s) de ${now.length} total em ${Date.now() - t0}ms`)
  return fresh
}

export function resetEditDiagnostics(): void {
  baseline = null
  baselinePending = null
  dirty = false
  disabled = false
  editedBeforeBaseline = false
  buildInfoPath = ''
}

/** Texto injectado entre turnos. Vazio quando não há nada — o caller concatena. */
export function formatDiagnosticsReminder(found: EditDiagnostic[], projectRoot = ''): string {
  if (found.length === 0) return ''
  const rel = (p: string) =>
    projectRoot && p.startsWith(projectRoot) ? p.slice(projectRoot.length).replace(/^[/\\]/, '') : p
  const shown = found.slice(0, MAX_SHOWN)
  const body = shown
    .map(d => `  ${d.severity === 'error' ? '✗' : '⚠'} ${rel(d.file)}:${d.line}:${d.column} — ${d.message} (TS${d.code})`)
    .join('\n')
  const more = found.length > MAX_SHOWN ? `\n  …+${found.length - MAX_SHOWN} more` : ''
  const errors = found.filter(d => d.severity === 'error').length
  return (
    `<system-reminder>\n` +
    `\`tsc --noEmit\` reports ${found.length} new diagnostic${found.length === 1 ? '' : 's'}` +
    (errors > 0 ? ` (${errors} error${errors === 1 ? '' : 's'})` : '') +
    ` that were NOT present before your edits:\n${body}${more}\n` +
    `Fix them in this turn — a removed symbol that is still referenced does not compile. ` +
    `This is the project's own type checker, not a guess.\n` +
    `</system-reminder>`
  )
}

/**
 * `tsc --noEmit --incremental` no projecto. Devolve `null` quando o projecto
 * não tem TypeScript utilizável — o caller desliga-se para o resto do run.
 *
 * `--incremental` é o que torna isto viável: 9,5s na primeira passagem, ~1,7s
 * nas seguintes (medido). O `.tsbuildinfo` fica onde o `tsconfig` mandar.
 */
async function runTsc(projectRoot: string): Promise<EditDiagnostic[] | null> {
  let res: CommandResult
  try {
    res = await invoke<CommandResult>('execute_command', {
      command: 'npx --no-install tsc --noEmit --incremental --pretty false'
        + (buildInfoPath ? ` --tsBuildInfoFile ${JSON.stringify(buildInfoPath)}` : ''),
      cwd: projectRoot,
      timeoutSecs: TIMEOUT_SECS,
    })
  } catch {
    return null
  }
  const out = `${res.stdout || ''}\n${res.stderr || ''}`
  // Sem tsconfig / sem typescript instalado: não é um projecto TS, desiste.
  if (/Cannot find module 'typescript'|not found|TS5058|TS6053/.test(out)) return null
  return parseTscOutput(out)
}

/** `path(line,col): error TS1234: message` — formato do `tsc --pretty false`. */
export function parseTscOutput(output: string): EditDiagnostic[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.*)$/
  const out: EditDiagnostic[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = re.exec(line.trim())
    if (!m) continue
    out.push({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] as 'error' | 'warning',
      code: Number(m[5]),
      message: m[6].trim(),
    })
  }
  return out
}
