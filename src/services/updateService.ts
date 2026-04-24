/**
 * Auto-update service.
 * Checks for updates on app startup, shows a toast notification,
 * and allows the user to download + install + relaunch.
 */

import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { getVersion } from '@tauri-apps/api/app'
import { useUpdateStore, type UpdateInfo } from '../stores/updateStore'
import { IS_VITE_DEV } from '../utils/viteEnv'
import { compareSemver } from '../utils/semver'

let checkedThisSession = false

export { type UpdateInfo }

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

/**
 * Drop any stale `pendingUpdate` left over from a previous session whose
 * target version is already installed. Without this, the banner rehydrates
 * from localStorage and reappears after the user completed the update —
 * pointing at their own current version.
 */
export async function reconcilePendingUpdate(): Promise<void> {
  const store = useUpdateStore.getState()
  const pending = store.pendingUpdate
  if (!pending) return
  try {
    const currentVersion = await getVersion()
    if (compareSemver(pending.version, currentVersion) <= 0) {
      console.info(`[updater] Clearing stale pendingUpdate — current=${currentVersion} >= pending=${pending.version}`)
      store.setPendingUpdate(null)
    }
  } catch (err) {
    console.warn('[updater] reconcilePendingUpdate failed:', err)
  }
}

/** Download, install, and relaunch the app. */
export async function installUpdate(): Promise<void> {
  // DEBUG: Simulate installation flow for testing
  if (IS_VITE_DEV && window.localStorage.getItem('SIMULATE_UPDATE') === 'true') {
    console.info('[updater] Simulating download and install...')
    await new Promise(r => setTimeout(r, 2000)) // Simulate download time
    alert('Simulação: A aplicação iria reiniciar agora para aplicar a versão 99.9.9')
    useUpdateStore.getState().setPendingUpdate(null)
    return
  }

  const update = await check()
  if (!update) throw new Error('No update available')

  await update.downloadAndInstall((progress) => {
    if (progress.event === 'Started' && progress.data.contentLength) {
      console.info(`[updater] Downloading ${(progress.data.contentLength / 1024 / 1024).toFixed(1)}MB...`)
    }
  })

  // Clear the persisted banner state before relaunch — otherwise the next
  // boot rehydrates and shows the banner again pointing at the version the
  // user just installed.
  useUpdateStore.getState().setPendingUpdate(null)

  await relaunch()
}

/** Pending update info (set after check, consumed by Settings UI) */
export function getPendingUpdate(): UpdateInfo | null {
  return useUpdateStore.getState().pendingUpdate
}

export function setPendingUpdate(update: UpdateInfo | null): void {
  useUpdateStore.getState().setPendingUpdate(update)
}

/** Auto-check on startup and periodically (every 6 hours). Shows banner if update available. */
export async function autoCheckForUpdate(): Promise<void> {
  if (checkedThisSession) return
  checkedThisSession = true

  // Reconcile before any check — a just-updated user shouldn't briefly see
  // the stale banner from their previous session while we wait the 5s
  // startup delay or the Tauri check round-trip.
  await reconcilePendingUpdate()

  const performCheck = async () => {
    try {
      // DEBUG: Simulate a fake update for testing
      if (IS_VITE_DEV && window.localStorage.getItem('SIMULATE_UPDATE') === 'true') {
        useUpdateStore.getState().setPendingUpdate({
          version: '99.9.9',
          body: 'Esta é uma atualização de teste para validar o sistema de notificações.',
          date: new Date().toISOString(),
        })
        return
      }

      const update = await checkForUpdate()
      if (!update) {
        // No update available — clear any stale pending entry.
        if (useUpdateStore.getState().pendingUpdate) {
          useUpdateStore.getState().setPendingUpdate(null)
        }
        return
      }
      useUpdateStore.getState().setPendingUpdate(update)
    } catch (err) {
      console.warn('[updater] Check failed:', err)
    }
  }

  // Initial check after startup delay
  setTimeout(performCheck, 5000)

  // Periodic check every 6 hours
  setInterval(performCheck, 6 * 60 * 60 * 1000)
}
