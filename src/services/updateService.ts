/**
 * Auto-update service.
 * Checks for updates on app startup, on window focus, and periodically while
 * the IDE is open. Shows a banner notification when a newer version is
 * available; clicking download + install relaunches the app.
 */

import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { getVersion } from '@tauri-apps/api/app'
import { useUpdateStore, type UpdateInfo } from '../stores/updateStore'
import { IS_VITE_DEV } from '../utils/viteEnv'
import { compareSemver } from '../utils/semver'
import { t } from '../i18n'

let checkedThisSession = false

/** Periodic re-check interval — short enough to catch hot releases within a
 *  typical work session, long enough that we don't hammer the updater. */
const PERIODIC_CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1h

/** Minimum gap between any two checks regardless of trigger (focus, interval,
 *  manual). Stops focus-thrash from spamming the updater when the user is
 *  alt-tabbing rapidly between windows. */
const MIN_CHECK_GAP_MS = 15 * 60 * 1000 // 15min

let lastCheckAtMs = 0

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
  if (!update) throw new Error(t('update.noUpdate'))

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

/**
 * Auto-check on startup, on window focus, and every 1h while the IDE is
 * open. Shows banner if update available. All triggers funnel through one
 * `performCheck` so the 15min throttle applies uniformly.
 */
export async function autoCheckForUpdate(): Promise<void> {
  if (checkedThisSession) return
  checkedThisSession = true

  // Reconcile before any check — a just-updated user shouldn't briefly see
  // the stale banner from their previous session while we wait the 5s
  // startup delay or the Tauri check round-trip.
  await reconcilePendingUpdate()

  const performCheck = async (trigger: 'startup' | 'interval' | 'focus') => {
    // Throttle. Avoids hammering the updater when focus events fire rapidly
    // (alt-tab, window manager re-focusing). Startup is exempt — it sets the
    // baseline timestamp, so a focus event seconds later doesn't trigger a
    // duplicate check.
    if (trigger !== 'startup' && Date.now() - lastCheckAtMs < MIN_CHECK_GAP_MS) {
      return
    }
    // Skip if we already have a pending update — user hasn't acted on it yet,
    // re-checking can't surface anything they don't already see in the banner.
    if (useUpdateStore.getState().pendingUpdate) {
      return
    }
    lastCheckAtMs = Date.now()

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
      console.info(`[updater] ${trigger}: update available v${update.version}`)
      useUpdateStore.getState().setPendingUpdate(update)
    } catch (err) {
      console.warn(`[updater] check (${trigger}) failed:`, err)
    }
  }

  // Initial check after startup delay
  setTimeout(() => performCheck('startup'), 5000)

  // Periodic check every 1h
  setInterval(() => performCheck('interval'), PERIODIC_CHECK_INTERVAL_MS)

  // Re-check when the user returns to the app (alt-tab back, system wake).
  // Throttled to 15min minimum gap to avoid spam.
  window.addEventListener('focus', () => performCheck('focus'))
}
