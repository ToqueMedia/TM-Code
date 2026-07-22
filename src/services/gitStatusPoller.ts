import { hasOwnRepo } from './repoOwnership'
import { GitService } from './gitService'
import { useGitStatusStore } from '../stores/gitStatusStore'

// Single shared git-status poller. Replaces the per-component 6s setIntervals
// (SourceControlPanel + EditorToolbar badge) that fired duplicate
// git_status_files IPCs every cycle. Refresh strategy, by design — reactive
// first, polling as safety net only:
//   - immediate refresh when the first consumer mounts (with spinner)
//   - 'git:refreshGutter' events (debounced): the agent's own file edits
//     (toolExecutor dispatches after every mutating tool) + panel actions
//   - a watcher on the TOP LEVEL of .git/ — catches commits/checkouts/
//     stages/fetches done in an external terminal (index, HEAD, ORIG_HEAD,
//     COMMIT_EDITMSG, FETCH_HEAD). Non-recursive on purpose: .git/objects
//     churn never reaches us
//   - refresh on window focus (the moment external changes become relevant)
//   - slow 60s background tick, SKIPPED while unfocused — pure safety net
//     for watcher-miss cases (network drives, unsupported filesystems)
// Consumers call acquireGitStatusPolling(path) on mount and the returned
// release on unmount; polling runs only while at least one consumer is alive.

const BACKGROUND_INTERVAL_MS = 60_000
const EVENT_DEBOUNCE_MS = 800

let currentPath = ''
let refCount = 0
let intervalId: ReturnType<typeof setInterval> | null = null
let debounceId: ReturnType<typeof setTimeout> | null = null
let inFlight = false
let unwatchGitDir: (() => void) | null = null
/** Guards the async watch() setup against a path switch racing it. */
let watchToken = 0

/**
 * ARMADILHA DO REPO ANCESTRAL (2026-07-17, report do user): projecto SEM repo
 * próprio dentro de uma pasta-ancestral versionada (~/dev é um repo!) fazia o
 * git status resolver contra o ANCESTRAL — o painel mostrava as alterações de
 * TODOS os projectos do user como se fossem deste. Só confiamos no git quando
 * o toplevel é a PRÓPRIA raiz do projecto (mesma guarda da taskWorktree).
 */
async function projectHasOwnRepo(path: string): Promise<boolean> {
  // Delegado ao helper cross-platform (a versão inline era POSIX-only e no
  // Windows — cmd /C — devolvia sempre false: Source Control ficava vazio).
  return hasOwnRepo(path)
}

export async function refreshGitStatus(opts?: { spinner?: boolean }): Promise<void> {
  const path = currentPath
  if (!path || inFlight) return
  inFlight = true
  if (opts?.spinner) useGitStatusStore.getState()._update({ loading: true })
  try {
    if (!(await projectHasOwnRepo(path))) {
      // Sem repo PRÓPRIO = painel limpo e honesto ("sem git"), nunca o
      // estado do repo pai. Verificado a cada ciclo: um git init posterior
      // (ex.: auto-init das tarefas) é apanhado no refresh seguinte.
      if (path === currentPath) {
        useGitStatusStore.getState()._update({ files: [], branch: '', ahead: 0, behind: 0, hasUpstream: false })
      }
      return
    }
    const [files, branch] = await Promise.all([
      GitService.getStatusFiles(path),
      GitService.getCurrentBranch(path),
    ])
    let ahead = 0
    let behind = 0
    let hasUpstream = false
    // Ahead/behind vs upstream — fails harmlessly when there is no remote or
    // no upstream configured (the commit button then never enters sync mode).
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{ stdout: string; success: boolean }>('execute_command', {
        command: 'git rev-list --left-right --count @{upstream}...HEAD',
        cwd: path,
        timeoutSecs: 5,
      })
      if (res.success) {
        const [b = 0, a = 0] = res.stdout.trim().split(/\s+/).map(Number)
        behind = b || 0
        ahead = a || 0
        hasUpstream = true
      }
    } catch {
      /* keep defaults */
    }
    // Project switched while this refresh was in flight — drop stale result.
    if (path === currentPath) {
      useGitStatusStore.getState()._update({ files, branch, ahead, behind, hasUpstream })
    }
  } catch {
    if (path === currentPath) useGitStatusStore.getState()._update({ files: [] })
  } finally {
    if (opts?.spinner) useGitStatusStore.getState()._update({ loading: false })
    inFlight = false
  }
}

const onFocus = () => { void refreshGitStatus() }

const onExternalChange = () => {
  if (debounceId) clearTimeout(debounceId)
  debounceId = setTimeout(() => { void refreshGitStatus() }, EVENT_DEBOUNCE_MS)
}

function stopGitDirWatch() {
  watchToken += 1
  if (unwatchGitDir) {
    try { unwatchGitDir() } catch { /* already gone */ }
    unwatchGitDir = null
  }
}

async function startGitDirWatch(path: string) {
  stopGitDirWatch()
  const token = watchToken
  try {
    const { watch } = await import('@tauri-apps/plugin-fs')
    const unwatch = await watch(
      `${path}/.git`,
      () => onExternalChange(),
      // delayMs batches notify bursts (a single commit touches several files)
      { recursive: false, delayMs: 500 },
    )
    // Path switched or poller stopped while watch() was being set up.
    if (token !== watchToken || path !== currentPath) {
      try { unwatch() } catch { /* noop */ }
      return
    }
    unwatchGitDir = unwatch
  } catch {
    // Not a git repo, watch unsupported on this filesystem, or capability
    // missing — the 60s background tick remains as the fallback.
    unwatchGitDir = null
  }
}

/**
 * Register a consumer of the shared git status. Starts polling when the first
 * consumer arrives; stops when the last one releases. Returns the release fn.
 */
export function acquireGitStatusPolling(projectPath: string): () => void {
  if (!projectPath) return () => {}

  if (projectPath !== currentPath) {
    currentPath = projectPath
    useGitStatusStore.getState()._reset()
    // Path switched while other consumers are alive — refresh + rewatch.
    if (refCount > 0) {
      void refreshGitStatus({ spinner: true })
      void startGitDirWatch(projectPath)
    }
  }

  refCount += 1
  if (refCount === 1) {
    window.addEventListener('focus', onFocus)
    window.addEventListener('git:refreshGutter', onExternalChange as EventListener)
    intervalId = setInterval(() => {
      if (document.hasFocus()) void refreshGitStatus()
    }, BACKGROUND_INTERVAL_MS)
    void refreshGitStatus({ spinner: true })
    void startGitDirWatch(projectPath)
  } else {
    // A new consumer appeared (e.g. the SC panel just opened while the
    // toolbar badge was already polling) — don't make it stare at data
    // that can be up to BACKGROUND_INTERVAL_MS old.
    void refreshGitStatus()
  }

  let released = false
  return () => {
    if (released) return
    released = true
    refCount -= 1
    if (refCount === 0) {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('git:refreshGutter', onExternalChange as EventListener)
      if (intervalId) { clearInterval(intervalId); intervalId = null }
      if (debounceId) { clearTimeout(debounceId); debounceId = null }
      stopGitDirWatch()
    }
  }
}
