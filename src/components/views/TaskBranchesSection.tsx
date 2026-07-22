/**
 * Secção "Branches de Tarefas" do Source Control — o FECHO do ciclo
 * multi-agent (doutrina "sem deus", ARCHITECTURE.md): cada tarefa trabalha
 * numa branch `worktree/<name>`; aqui o developer REVÊ e FUNDE esse trabalho
 * (merge é a revisão — as tarefas não têm aprovação de diffs por design) e
 * faz o housekeeping (apagar branch + worktree quando consumidos).
 *
 * Auto-contida: lista `refs/heads/worktree/*` com contagem de commits por
 * fundir (uma invocação shell agregada), marca as branches de tarefas VIVAS
 * (parallelTaskStore — sem ações até a tarefa terminar) e expõe Merge +
 * Apagar. Conflitos de merge caem na secção "Conflitos de Merge" existente
 * do painel (refreshGitStatus fá-la aparecer) — mesma máquina do VS Code.
 */

import { hasOwnRepo } from '../../services/repoOwnership'
import { memo, useCallback, useEffect, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { VscChevronDown, VscChevronRight, VscGitMerge, VscTrash, VscRefresh } from 'react-icons/vsc'
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog'
import { invoke } from '@/utils/invokeMetrics'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { useParallelTaskStore } from '@/stores/parallelTaskStore'
import { refreshGitStatus } from '@/services/gitStatusPoller'
import { WORKTREES_REL_DIR } from '@/services/agent/toolExecutor/worktrees'

interface CommandResult { stdout: string; stderr: string; exitCode: number; success: boolean }

interface TaskBranchInfo {
  branch: string
  /** Commits que a branch tem além do HEAD atual (o que o merge traz). */
  ahead: number
}

async function runGit(command: string, cwd: string): Promise<CommandResult> {
  return invoke<CommandResult>('execute_command', { command, cwd, timeoutSecs: 60 })
}

/** Lista branches worktree/* + ahead-count — comandos git PUROS (o pipeline
 *  `while read` original era POSIX-only e falhava no cmd /C do Windows). */
async function listTaskBranches(projectPath: string): Promise<TaskBranchInfo[]> {
  // Guarda anti-repo-ancestral (mesma da taskWorktree): sem repo PRÓPRIO na
  // raiz, o for-each-ref listaria branches do repo PAI (~/dev era um repo).
  if (!(await hasOwnRepo(projectPath))) return []
  const r = await runGit('git for-each-ref --format="%(refname:short)" refs/heads/worktree/', projectPath)
  if (!r.success || r.exitCode !== 0) return []
  const out: TaskBranchInfo[] = []
  for (const line of r.stdout.split('\n')) {
    const branch = line.trim().replace(/^"|"$/g, '')
    if (!branch) continue
    // Uma ida por branch — são poucas e o custo é local.
    const count = await runGit(`git rev-list --count HEAD.."${branch}"`, projectPath)
    const ahead =
      count.success && count.exitCode === 0 ? parseInt(count.stdout.trim(), 10) || 0 : 0
    out.push({ branch, ahead })
  }
  return out
}

const TaskBranchesSection = memo<{
  projectPath: string
  currentBranch: string
  onFeedback: (type: 'success' | 'error', msg: string) => void
}>(({ projectPath, currentBranch, onFeedback }) => {
  const [open, setOpen] = useState(true)
  const [branches, setBranches] = useState<TaskBranchInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  // O Map muda de referência a cada set do store — dependência estável para
  // re-scan quando uma tarefa termina (o auto-commit dela muda o ahead).
  const runs = useParallelTaskStore(s => s.runs)

  const reload = useCallback(async () => {
    if (!projectPath) return
    try { setBranches(await listTaskBranches(projectPath)) } catch { /* sem git — secção vazia */ }
  }, [projectPath])

  useEffect(() => { void reload() }, [reload, currentBranch, runs])

  // Branch de uma tarefa VIVA: sem ações até ela terminar (fundir/apagar a
  // árvore debaixo de um agente a meio é sabotagem).
  const liveBranches = new Set<string>()
  for (const run of runs.values()) {
    if ((run.status === 'running' || run.status === 'queued') && run.worktree?.branch) {
      liveBranches.add(run.worktree.branch)
    }
  }

  const onMerge = useCallback(async (branch: string) => {
    const ok = await tauriConfirm(
      t('sourceControl.taskBranchMergeConfirm').replace('{from}', branch).replace('{into}', currentBranch),
      { title: t('sourceControl.taskBranches'), kind: 'info' },
    )
    if (!ok) return
    setBusy(branch)
    try {
      // --no-ff: o merge-commit preserva a proveniência do trabalho da tarefa.
      const r = await runGit(`git merge --no-ff "${branch}" -m "tm: merge ${branch}"`, projectPath)
      const outText = `${r.stdout}\n${r.stderr}`
      if (r.success && r.exitCode === 0) {
        onFeedback('success', t('sourceControl.taskBranchMerged').replace('{branch}', branch))
      } else if (/conflict/i.test(outText)) {
        onFeedback('error', t('sourceControl.taskBranchMergeConflicts'))
      } else {
        onFeedback('error', outText.trim().slice(0, 300) || 'git merge failed')
      }
    } finally {
      setBusy(null)
      await refreshGitStatus()
      await reload()
    }
  }, [projectPath, currentBranch, onFeedback, reload])

  const onDelete = useCallback(async (branch: string) => {
    const ok = await tauriConfirm(
      t('sourceControl.taskBranchDeleteConfirm').replace('{branch}', branch),
      { title: t('sourceControl.taskBranches'), kind: 'warning' },
    )
    if (!ok) return
    setBusy(branch)
    try {
      // Diretório por construção (taskWorktree.ts): worktree/<name> vive em
      // <projeto>/.toquemedia/worktrees/<name>. Remove worktree ANTES da
      // branch (git recusa -D de branch checked-out); prune limpa registos
      // órfãos de dirs já apagados à mão.
      const name = branch.startsWith('worktree/') ? branch.slice('worktree/'.length) : branch
      const dir = `${projectPath}/${WORKTREES_REL_DIR}/${name}`
      // Comandos SEPARADOS (`;`/`2>/dev/null` não existem no cmd do Windows);
      // o remove pode falhar se o dir já foi apagado à mão — segue na mesma.
      await runGit(`git worktree remove --force "${dir}"`, projectPath)
      await runGit('git worktree prune', projectPath)
      const r = await runGit(`git branch -D "${branch}"`, projectPath)
      if (r.success && r.exitCode === 0) {
        onFeedback('success', t('sourceControl.taskBranchDeleted'))
      } else {
        onFeedback('error', `${r.stdout}\n${r.stderr}`.trim().slice(0, 300) || 'git branch -D failed')
      }
    } finally {
      setBusy(null)
      await refreshGitStatus()
      await reload()
    }
  }, [projectPath, onFeedback, reload])

  if (branches.length === 0) return null

  return (
    <Box borderBottom={`1px solid ${tokens.colors.border.subtle}`} flexShrink={0}>
      <Flex
        as="button" w="100%" align="center" gap={1} px={2} py="4px" cursor="pointer"
        _hover={{ bg: 'rgba(255,255,255,0.04)' }}
        onClick={() => setOpen(v => !v)}
      >
        {open ? <VscChevronDown size={12} /> : <VscChevronRight size={12} />}
        <Text fontSize="11px" fontWeight="700" letterSpacing="0.04em" color={tokens.colors.text.secondary} textTransform="uppercase">
          {t('sourceControl.taskBranches')}
        </Text>
        <Text fontSize="10px" color={tokens.colors.text.disabled}>({branches.length})</Text>
        <Box flex={1} />
        <Flex
          as="span" role="button" p="2px" borderRadius="4px" color={tokens.colors.text.muted}
          _hover={{ color: tokens.colors.text.primary }}
          onClick={(e) => { e.stopPropagation(); void reload() }}
          title={t('sourceControl.taskBranchRefresh')}
        >
          <VscRefresh size={12} />
        </Flex>
      </Flex>
      {open && branches.map(b => {
        const live = liveBranches.has(b.branch)
        const isBusy = busy === b.branch
        return (
          <Flex key={b.branch} align="center" gap={2} pl="22px" pr={2} py="3px" _hover={{ bg: 'rgba(255,255,255,0.03)' }}>
            <VscGitMerge size={12} color={tokens.colors.accent.purple} style={{ flexShrink: 0 }} />
            <Text fontSize="11px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.text.primary} flex={1} minW={0} truncate title={b.branch}>
              {b.branch}
            </Text>
            {live ? (
              <Text fontSize="10px" color={tokens.colors.accent.primary} flexShrink={0}>
                {t('sourceControl.taskBranchLive')}
              </Text>
            ) : (
              <Text fontSize="10px" color={b.ahead > 0 ? tokens.colors.accent.greenBright : tokens.colors.text.disabled} flexShrink={0}>
                {b.ahead > 0 ? `+${b.ahead}` : t('sourceControl.taskBranchNothing')}
              </Text>
            )}
            {!live && (
              <>
                <Flex
                  as="span" role="button" p="2px" borderRadius="4px"
                  color={isBusy ? tokens.colors.text.disabled : tokens.colors.text.muted}
                  _hover={{ color: tokens.colors.accent.greenBright }}
                  pointerEvents={isBusy ? 'none' : 'auto'}
                  onClick={() => void onMerge(b.branch)}
                  title={t('sourceControl.taskBranchMerge').replace('{branch}', currentBranch)}
                >
                  <VscGitMerge size={13} />
                </Flex>
                <Flex
                  as="span" role="button" p="2px" borderRadius="4px"
                  color={isBusy ? tokens.colors.text.disabled : tokens.colors.text.muted}
                  _hover={{ color: tokens.colors.status.error }}
                  pointerEvents={isBusy ? 'none' : 'auto'}
                  onClick={() => void onDelete(b.branch)}
                  title={t('sourceControl.taskBranchDelete')}
                >
                  <VscTrash size={13} />
                </Flex>
              </>
            )}
          </Flex>
        )
      })}
    </Box>
  )
})
TaskBranchesSection.displayName = 'TaskBranchesSection'

export default TaskBranchesSection
