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
