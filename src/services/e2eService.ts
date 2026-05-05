import { invoke } from '@tauri-apps/api/core'
import { useE2EStore } from '../stores/e2eStore'

export interface BrowserInfo {
  id: string
  name: string
  path: string
  channel: string | null
  executable_path: string | null
}

let cache: { ts: number; data: BrowserInfo[] } | null = null
// 60s — short enough that a user installing Chrome mid-session sees the
// new browser within a minute, long enough to avoid spamming filesystem
// scans during rapid-fire calls (e.g. several /te2e in quick succession).
const CACHE_TTL_MS = 60 * 1000

export async function detectTestBrowsers(force = false): Promise<BrowserInfo[]> {
  if (!force && cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.data
  }
  const data = await invoke<BrowserInfo[]>('detect_test_browsers')
  cache = { ts: Date.now(), data }
  return data
}

export function pickPreferredBrowser(list: BrowserInfo[]): BrowserInfo | null {
  return list.find(b => b.channel !== null) ?? list[0] ?? null
}

/**
 * Resolves to a usable browser, or `null` if none is available and the user
 * declined the install prompt. Re-detects after the dialog accepts so users
 * who installed Chrome and re-opened the app pick it up without restart.
 */
export async function ensureTestBrowser(): Promise<BrowserInfo | null> {
  let browsers = await detectTestBrowsers(true)
  let preferred = pickPreferredBrowser(browsers)
  if (preferred) return preferred

  const accepted = await useE2EStore.getState().promptBrowserMissing()
  if (!accepted) return null

  browsers = await detectTestBrowsers(true)
  preferred = pickPreferredBrowser(browsers)
  return preferred
}
