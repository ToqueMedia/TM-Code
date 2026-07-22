/**
 * Fase 5 do modelo foreground: isolamento OPT-IN de tarefas paralelas em git
 * worktrees (padrão Cursor/claude-vaz — cada agente na sua working tree +
 * branch, merge deliberado pelo developer).
 *
 * Reutiliza as convenções da máquina enter_worktree/exit_worktree
 * (toolExecutor/worktrees.ts): os worktrees vivem DENTRO do projecto em
 * `.toquemedia/worktrees/<name>` — o clamp de paths (project root) continua a
 * valer sem alterações — e ficam fora do `git status` do checkout principal
 * via `.git/info/exclude`.
 *
 * Contrato de fim de tarefa: NUNCA remove o worktree (doutrina decideRemove:
 * preservar trabalho). O runner auto-commita alterações soltas no fim para a
 * branch ficar consumível ("git merge <branch>" / Source Control); a nota no
 * chat da tarefa diz exatamente onde o trabalho vive.
 */

import { invoke } from '@/utils/invokeMetrics'
import { formatError } from '../../../utils/errors'
import { WORKTREES_REL_DIR, worktreeBranch, sanitizeWorktreeName } from '../toolExecutor/worktrees'
import { hasOwnRepo, ensureGitInfoExclude } from '../../repoOwnership'

export interface TaskWorktree {
  /** Raiz do checkout principal (onde o merge acontecerá). */
  originalRoot: string
  /** Diretório do worktree — o cwd da tarefa enquanto corre. */
  path: string
  branch: string
  name: string
  baseRef: string
}

async function runGit(command: string, cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await invoke<{ stdout: string; stderr: string; exitCode: number; success: boolean }>(
      'execute_command',
      { command, cwd, timeoutSecs: 60 },
    )
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()
    return { ok: r.success && r.exitCode === 0, out }
  } catch (e) {
    return { ok: false, out: formatError(e) }
  }
}

/**
 * Cria o worktree da tarefa. Devolve null quando o isolamento não é possível
 * (projecto sem git / sem commits / falha do git) — a tarefa corre na working
 * tree partilhada como antes; o caller decide como comunicar isso.
 */
export interface CreateWorktreeResult {
  worktree: TaskWorktree | null
  /** O sistema criou agora um repositório git local (projecto sem repo/commits). */
  repoInitialized: boolean
}

export async function createTaskWorktree(
  projectRoot: string,
  runId: string,
): Promise<CreateWorktreeResult> {
  let repoInitialized = false
  // ARMADILHA DO REPO ANCESTRAL: só confiamos em HEAD/worktree se o toplevel
  // for a PRÓPRIA raiz do projecto — ver hasOwnRepo. NB: rev-parse --git-dir
  // também resolvia contra o ancestral, por isso não serve de guarda.
  const owns = await hasOwnRepo(projectRoot)
  let head = owns ? await runGit('git rev-parse HEAD', projectRoot) : { ok: false, out: '' }
  if (!head.ok) {
    // Git é requisito da IDE (required-tools gate) e worktree é o DEFAULT por
    // design — um projecto sem repo/commits ganha um repositório LOCAL agora
    // (decisão do user 2026-07-16). Sem remoto: o user publica se/quando quiser.
    if (!owns) {
      const init = await runGit('git init', projectRoot)
      if (!init.ok) return { worktree: null, repoInitialized: false }
    }
    // EXCLUDES ANTES DO COMMIT INICIAL (ordem crítica — incidente 2026-07-17):
    // a versão antiga escrevia o exclude DEPOIS do `git add -A`, o
    // .toquemedia-id entrava na branch, e um merge/checkout posterior
    // REESCREVIA a identidade do projecto com um id de outra era/projecto —
    // split-brain de estado (sessões espalhadas por duas pastas, rows a
    // desaparecer, notas "cruzadas" entre tarefas).
    await ensureGitInfoExclude(projectRoot, [`${WORKTREES_REL_DIR}/`, '.toquemedia-id'])
    // .gitignore mínimo antes do commit inicial — sem ele, `git add -A` num
    // projecto já instalado arrastava node_modules para o repo. Via fs — o
    // cmd do Windows não tem [ ]/printf.
    try {
      await invoke<string>('read_file', { path: `${projectRoot}/.gitignore` })
    } catch {
      try {
        await invoke('write_file', {
          path: `${projectRoot}/.gitignore`,
          content: 'node_modules/\ndist/\nbuild/\n.env\n.env.*\n.DS_Store\n.toquemedia/\n.toquemedia-id\n',
        })
      } catch {
        /* best-effort */
      }
    }
    const commit = await runGit(
      'git add -A && git -c user.name="TM Code" -c user.email="agent@tmcode.local" commit -m "tm: initial commit (repo local criado pelo TM Code)" --no-verify',
      projectRoot,
    )
    if (!commit.ok) return { worktree: null, repoInitialized: false }
    repoInitialized = true
    head = await runGit('git rev-parse HEAD', projectRoot)
    if (!head.ok) return { worktree: null, repoInitialized: true }
  }

  // Sufixo temporal: os runIds (task-N) recomeçam em 1 a cada arranque da
  // app — sem isto, `.toquemedia/worktrees/task-1` colidia com o de uma
  // sessão anterior e o git worktree add falhava (degradando SEMPRE para a
  // árvore partilhada depois do primeiro restart).
  // Repo pré-existente também precisa dos excludes (idempotente).
  await ensureGitInfoExclude(projectRoot, [`${WORKTREES_REL_DIR}/`, '.toquemedia-id'])

  const name =
    sanitizeWorktreeName(`${runId}-${Date.now().toString(36)}`) ?? `task-${Date.now().toString(36)}`
  const branch = worktreeBranch(name)
  const dir = `${projectRoot}/${WORKTREES_REL_DIR}/${name}`

  // `.toquemedia-id` é identidade LOCAL da máquina (deploys) — os serviços
  // criam-no no worktree ao construir o prompt lá, e o `git add -A` da tarefa
  // commitava-o na branch (visto na sessão de 2026-07-17); um id cunhado no
  // worktree, fundido para main, pisava a identidade real do projecto. O
  // info/exclude é partilhado por todos os worktrees e só afeta ficheiros
  // por-trackear — projetos que já o versionam não mudam.

  const add = await runGit(`git worktree add "${dir}" -b "${branch}"`, projectRoot)
  if (!add.ok) return { worktree: null, repoInitialized }

  // TMS.md por commitar não existe no worktree (nasce do HEAD) — mas a
  // memória do projecto deve viajar com CADA developer (o prompt da tarefa
  // constrói-se na raiz do worktree). Copia quando falta lá; se o user
  // versiona TMS.md, o auto-commit do fim traz eventuais updates na branch —
  // comportamento normal de um ficheiro do projecto. Best-effort.
  try {
    const tms = await invoke<string>('read_file', { path: `${projectRoot}/TMS.md` })
    let existsInWorktree = true
    try {
      await invoke<string>('read_file', { path: `${dir}/TMS.md` })
    } catch {
      existsInWorktree = false
    }
    if (!existsInWorktree) await invoke('write_file', { path: `${dir}/TMS.md`, content: tms })
  } catch {
    /* projecto sem TMS.md */
  }

  return {
    worktree: {
      originalRoot: projectRoot,
      path: dir,
      branch,
      name,
      baseRef: head.out.split('\n')[0] ?? '',
    },
    repoInitialized,
  }
}

/**
 * Reutiliza um worktree JÁ criado por um run anterior da MESMA sessão
 * (continuação de um chat de tarefa no mesmo processo): valida que o dir
 * ainda existe e é um checkout git são. baseRef = HEAD atual do worktree —
 * o aheadCount do fecho conta só o trabalho NOVO deste run.
 */
export async function reuseTaskWorktree(
  projectRoot: string,
  path: string,
  branch: string,
): Promise<TaskWorktree | null> {
  const head = await runGit('git rev-parse HEAD', path)
  if (!head.ok) return null
  const name = path.split('/').pop() ?? branch
  return { originalRoot: projectRoot, path, branch, name, baseRef: head.out.split('\n')[0] ?? '' }
}

/** Ficheiros com alterações POR COMMITAR no checkout principal — trabalho em
 *  curso do developer. As tarefas não lhes tocam (regra de propriedade). */
export async function dirtyFilesInMainCheckout(projectRoot: string): Promise<Set<string>> {
  const files = new Set<string>()
  // Sem repo PRÓPRIO, o status viria do repo ANCESTRAL (WIP de outro
  // projecto, caminhos relativos ao pai) — baseline vazio é o honesto.
  if (!(await hasOwnRepo(projectRoot))) return files
  const status = await runGit('git status --porcelain', projectRoot)
  if (!status.ok) return files
  for (const line of status.out.split('\n')) {
    if (!line.trim()) continue
    // Formato: "XY caminho" | "XY antigo -> novo" (renames usam o novo).
    let rest = line.slice(3).trim()
    const arrow = rest.indexOf(' -> ')
    if (arrow >= 0) rest = rest.slice(arrow + 4)
    files.add(rest.replace(/^"|"$/g, ''))
  }
  return files
}

/**
 * AUTO-MERGE no fim da tarefa (decisão do produto 2026-07-17): a tarefa
 * completa funde-se SOZINHA na branch do developer — a nota "funde à mão"
 * só sobrevive como FALLBACK de conflito. Sucesso limpa worktree+branch
 * (`branch -d` só apaga se fundida — rede de segurança do próprio git);
 * conflito/recusa aborta o merge (branch do user fica intacta) e mantém
 * branch+worktree para o Source Control (Branches de Tarefas).
 */
export interface AutoMergeOutcome {
  merged: boolean
  conflicted: boolean
  userBranch: string
}

export async function autoMergeTaskBranch(
  wt: TaskWorktree,
  taskDescription: string,
): Promise<AutoMergeOutcome> {
  const branchRes = await runGit('git rev-parse --abbrev-ref HEAD', wt.originalRoot)
  const userBranch = branchRes.ok ? branchRes.out.split('\n')[0] : ''
  const msg = `tm: merge ${wt.branch} — ${taskDescription.replace(/"/g, "'").slice(0, 60)}`
  const merge = await runGit(`git merge --no-ff "${wt.branch}" -m "${msg}"`, wt.originalRoot)
  if (merge.ok) {
    // Trabalho já vive na branch do user — worktree/branch cumpriram o papel.
    // Comandos SEPARADOS — o `;` e o `2>/dev/null` não existem no cmd do
    // Windows; cada passo é best-effort por si.
    await runGit(`git worktree remove --force "${wt.path}"`, wt.originalRoot)
    await runGit('git worktree prune', wt.originalRoot)
    await runGit(`git branch -d "${wt.branch}"`, wt.originalRoot)
    return { merged: true, conflicted: false, userBranch }
  }
  const conflicted = /conflict/i.test(merge.out)
  // Nunca deixar a branch do user a meio de um merge falhado.
  await runGit('git merge --abort', wt.originalRoot)
  return { merged: false, conflicted, userBranch }
}

export interface TaskWorktreeOutcome {
  /** Havia alterações por commitar que foram auto-commitadas agora. */
  autoCommitted: boolean
  /** Commits na branch além do baseRef (inclui o auto-commit). */
  aheadCount: number
}

/**
 * Fecho do worktree no fim da tarefa: auto-commita trabalho solto (uma branch
 * suja não é consumível por merge) e mede o que a branch tem para oferecer.
 * O worktree fica SEMPRE no disco — remover é decisão do developer.
 */
export async function finalizeTaskWorktree(
  wt: TaskWorktree,
  taskDescription: string,
): Promise<TaskWorktreeOutcome> {
  let autoCommitted = false
  const status = await runGit('git status --porcelain', wt.path)
  if (status.ok && status.out.trim().length > 0) {
    const msg = `tm: ${taskDescription.replace(/"/g, "'").slice(0, 60)} (auto-commit da tarefa)`
    // Mesmo fallback de identidade do commit inicial — sem user.name/email
    // globais, o auto-commit falhava em silêncio e a nota dizia "0 commit(s)"
    // com a árvore suja (ronda estrutural 2026-07-17).
    const commit = await runGit(
      `git add -A && git -c user.name="TM Code" -c user.email="agent@tmcode.local" commit -m "${msg}" --no-verify`,
      wt.path,
    )
    autoCommitted = commit.ok
  }
  const ahead = await runGit(`git rev-list --count ${wt.baseRef}..HEAD`, wt.path)
  const aheadCount = ahead.ok ? parseInt(ahead.out, 10) || 0 : 0
  return { autoCommitted, aheadCount }
}
