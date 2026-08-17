/** User-home folder for TM Code app state (sessions, skills, mcp, memory). */
export const APP_HOME_DIR_NAME = '.tmcode'
/** Pre-rename folder. Read as fallback; never write new files here. */
export const LEGACY_APP_HOME_DIR_NAME = '.toquemedia-studio'

export function appHomePath(homeDir: string, ...segments: string[]): string {
  const normalized = homeDir.replace(/[/\\]+$/, '')
  return [normalized, APP_HOME_DIR_NAME, ...segments].join('/')
}

export function legacyAppHomePath(homeDir: string, ...segments: string[]): string {
  const normalized = homeDir.replace(/[/\\]+$/, '')
  return [normalized, LEGACY_APP_HOME_DIR_NAME, ...segments].join('/')
}
