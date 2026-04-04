/**
 * Auto-update service.
 * Checks for updates on app startup, shows a toast notification,
 * and allows the user to download + install + relaunch.
 */

import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { useToastStore } from '../stores/toastStore'

let checkedThisSession = false

export interface UpdateInfo {
  version: string
  body: string | null
  date: string | null
}

/** Check for updates. Returns update info if available, null if up-to-date. Throws on error. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const update = await check()
  if (!update) return null
  return {
    version: update.version,
    body: update.body ?? null,
    date: update.date ?? null,
  }
}

/** Download, install, and relaunch the app. */
export async function installUpdate(): Promise<void> {
  const update = await check()
  if (!update) throw new Error('No update available')

  await update.downloadAndInstall((progress) => {
    if (progress.event === 'Started' && progress.data.contentLength) {
      console.info(`[updater] Downloading ${(progress.data.contentLength / 1024 / 1024).toFixed(1)}MB...`)
    }
  })

  await relaunch()
}

/** Pending update info (set after check, consumed by Settings UI) */
let pendingUpdate: UpdateInfo | null = null

export function getPendingUpdate(): UpdateInfo | null {
  return pendingUpdate
}

/** Auto-check on startup (once per session). Shows toast if update available. */
export async function autoCheckForUpdate(): Promise<void> {
  if (checkedThisSession) return
  checkedThisSession = true

  // Delay check to not slow down startup
  await new Promise(r => setTimeout(r, 5000))

  try {
    const update = await checkForUpdate()
    if (!update) return

    // Store pending update so UI can show an update banner/button
    pendingUpdate = update

    useToastStore.getState().addToast(
      'info',
      `TM Code ${update.version} is available. Go to Settings to update.`,
      15000
    )
  } catch (err) {
    console.warn('[updater] Auto-check failed:', err)
  }
}
