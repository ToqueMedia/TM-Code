/**
 * Platform detection constants.
 *
 * Uses navigator.platform (deprecated but universally supported in all WebViews).
 * Safe to evaluate at module scope — navigator is always available in browser contexts.
 */

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '')
export const IS_WINDOWS = typeof navigator !== 'undefined' && /Win/.test(navigator.platform || '')
export const IS_LINUX = !IS_MAC && !IS_WINDOWS

/** File extensions supported by "Open File" dialog */
export const TEXT_FILE_EXTENSIONS = [
  'txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'css', 'html', 'xml',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'log', 'csv', 'env',
  'sh', 'bash', 'zsh', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cpp', 'h', 'hpp',
]

// ─── Cross-platform path helpers ───
// All UI code receives paths that may use `/` (Unix/macOS) or `\` (Windows).
// These helpers split on either separator so display logic works in all OSs.

const PATH_SEP = /[\\/]+/

/** Normalize separators to `/` for consistent display & matching. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

/** Last segment of a path. Works with both `/` and `\` separators. */
export function basename(path: string): string {
  if (!path) return ''
  return path.split(PATH_SEP).filter(Boolean).pop() || path
}

/** Split a path into segments using either separator. */
export function pathSegments(path: string): string[] {
  return path.split(PATH_SEP).filter(Boolean)
}

/**
 * Shorten a path to "…/parent/child/file" keeping the last `keep` segments.
 * Returns the original (normalized) path if it already has ≤ keep segments.
 */
export function shortenPath(path: string, keep = 3): string {
  const parts = pathSegments(path)
  if (parts.length <= keep) return normalizePath(path)
  return `…/${parts.slice(-keep).join('/')}`
}
