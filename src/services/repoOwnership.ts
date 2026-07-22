/**
 * Posse de repositório + escrita de excludes SEM shell POSIX — partilhado por
 * gitStatusPoller, taskWorktree, TaskBranchesSection e enter_worktree.
 *
 * REGRA WINDOWS (incidente 2026-07-17): `execute_command` corre `cmd /C` no
 * Windows — `$(...)`, `[ ]`, `{ }`, `;`, `printf`, `grep`, `pwd -P` e
 * `2>/dev/null` NÃO existem lá. A primeira versão destes guards era
 * POSIX-only e no Windows devolvia sempre "foreign": Source Control
 * permanentemente vazio e worktrees degradados. Composição permitida num
 * comando: apenas `&&` e aspas DUPLAS; lógica além disso vive em TypeScript
 * sobre outputs de comandos git PUROS, e escrita de ficheiros vai por
 * read_file/write_file (fs), nunca por echo/printf.
 */
import { invoke } from '@/utils/invokeMetrics'

export type RepoOwnership = 'own' | 'foreign' | 'none'

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
}

async function exec(command: string, cwd: string, timeoutSecs = 10): Promise<ExecResult | null> {
  try {
    return await invoke<ExecResult>('execute_command', { command, cwd, timeoutSecs })
  } catch {
    return null
  }
}

/**
 * `git rev-parse --show-prefix` a partir da raiz do projecto: output VAZIO ⇔
 * o cwd É o toplevel (repo próprio); não-vazio ⇔ estamos DENTRO de um repo
 * ancestral (~/dev era um repo — armadilha katondo 2026-07-17, o worktree
 * nascia com o checkout de OUTRO projecto); falha ⇔ sem repo nenhum. Um único
 * comando git puro — mesma semântica em sh e cmd, sem canonicalização de
 * paths do nosso lado.
 */
export async function checkRepoOwnership(projectRoot: string): Promise<RepoOwnership> {
  const r = await exec('git rev-parse --show-prefix', projectRoot)
  if (!r || !r.success || r.exitCode !== 0) return 'none'
  return r.stdout.trim() === '' ? 'own' : 'foreign'
}

/** true apenas quando o toplevel do git É a raiz do projecto. */
export async function hasOwnRepo(projectRoot: string): Promise<boolean> {
  return (await checkRepoOwnership(projectRoot)) === 'own'
}

/**
 * Garante linhas em `.git/info/exclude` do checkout principal (dir de
 * worktrees + `.toquemedia-id` — identidade local NUNCA pode entrar numa
 * branch: um merge reescrevia-a e bifurcava o estado do projecto, incidente
 * split-brain 2026-07-17). Via fs, não shell; idempotente; best-effort — o
 * exclude é proteção, não requisito (`.git/info` existe em qualquer repo
 * criado por git init/clone; num worktree `.git` é ficheiro e a escrita
 * falha silenciosamente, o que está certo: o exclude pertence ao principal).
 */
export async function ensureGitInfoExclude(repoRoot: string, lines: string[]): Promise<void> {
  const path = `${repoRoot}/.git/info/exclude`
  try {
    let current = ''
    try {
      current = await invoke<string>('read_file', { path })
    } catch {
      current = ''
    }
    const have = new Set(current.split(/\r?\n/).map((l) => l.trim()))
    const missing = lines.filter((l) => !have.has(l))
    if (missing.length === 0) return
    const head = current === '' || current.endsWith('\n') ? current : `${current}\n`
    await invoke('write_file', { path, content: `${head}${missing.join('\n')}\n` })
  } catch {
    /* best-effort */
  }
}
