/**
 * Shared constants + helpers for the Windows one-click dev-tool install.
 *
 * Both the onboarding ToolsStep and the startup RequirementsErrorScreen drive
 * the same Rust `install_dev_tool` command (download → silent install → PATH
 * refresh) and listen on the same `tool-install-progress` channel. Keeping the
 * installer URLs and the tool-id mapping in ONE place avoids the two surfaces
 * drifting when the CDN links are finalised.
 */

export type DevToolId = 'python' | 'node' | 'git'

/**
 * Direct installer URLs hosted on our CDN — used as the download source for the
 * Windows native install (and as the browser-download fallback). The Rust side
 * accepts these exact tool ids in `install_dev_tool`.
 *
 * NOTE: provisional asset URLs — replace with the final signed links.
 */
export const WINDOWS_DOWNLOAD_LINKS: Record<DevToolId, string> = {
  python: 'https://assets-tm.toquemedia.net/python-3.14.5-amd64.exe',
  node: 'https://assets-tm.toquemedia.net/node-v22.22.3-x64.msi',
  git: 'https://assets-tm.toquemedia.net/Git-2.54.0-64-bit.exe',
}

/**
 * Map a `GLOBAL_REQUIREMENTS` entry (its display `name` like "Node.js" /
 * "Python 3", or its raw `command` like "python3") to the installer tool id.
 * Returns null when the requirement isn't one the native installer handles.
 */
export function requirementToToolId(nameOrCommand: string): DevToolId | null {
  const s = nameOrCommand.toLowerCase()
  if (s.includes('node')) return 'node'
  if (s.includes('python')) return 'python'
  if (s.includes('git')) return 'git'
  return null
}

/** Payload emitted by the Rust installer on the `tool-install-progress` channel. */
export interface ToolInstallProgress {
  tool: DevToolId
  /** winget | downloading | installing | refreshing | done | error */
  phase: string
  percent: number | null
  message: string | null
}

/** Result returned by the `install_dev_tool` command. */
export interface ToolInstallResult {
  success: boolean
  method: string
  message: string
}

/** Short PT label for an in-flight install phase (shared UI copy). */
export const INSTALL_PHASE_LABELS: Record<string, string> = {
  winget: 'A instalar via winget…',
  downloading: 'A descarregar…',
  installing: 'A instalar…',
  refreshing: 'A verificar…',
}
