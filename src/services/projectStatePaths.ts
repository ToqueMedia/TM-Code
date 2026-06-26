import { invoke } from '@/utils/invokeMetrics'

const cache = new Map<string, string>()

export async function getProjectStateDir(projectPath: string): Promise<string> {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
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
