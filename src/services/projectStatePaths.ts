import { invoke } from '@/utils/invokeMetrics'

const cache = new Map<string, string>()

export async function getProjectStateDir(projectPath: string): Promise<string> {
  // Worktrees de tarefas pertencem ao PROJECTO: um caminho dentro de
  // .toquemedia/worktrees/<name> resolve para a identidade da raiz — sem
  // isto, o Rust cunhava um .toquemedia-id NOVO no worktree e o estado
  // bifurcava (bug real 2026-07-17). Espelho do strip_worktree_suffix (Rust).
  let normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  const wtIdx = normalized.indexOf('/.toquemedia/worktrees/')
  if (wtIdx >= 0) normalized = normalized.slice(0, wtIdx)
  const cached = cache.get(normalized)
  if (cached) return cached
  const dir = await invoke<string>('get_project_state_dir', { projectPath: normalized })
  const clean = dir.replace(/\\/g, '/').replace(/\/$/, '')
  cache.set(normalized, clean)
  return clean
}

export async function getProjectSessionsDir(projectPath: string): Promise<string> {
  return `${await getProjectStateDir(projectPath)}/sessions`
}

export function getLegacyProjectStateDir(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  return `${normalized}/.toquemedia`
}
