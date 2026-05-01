// Native OS notifications via tauri-plugin-notification.
//
// Apple HIG and Microsoft Notifications guidelines both say the same thing:
// notify only when the user *cannot* see the event. If the IDE window is
// already focused, in-app toasts are the right surface — firing an OS
// notification on top would be noise. This service centralises that check
// so call-sites don't have to think about it.
//
// First call after install lazily requests OS permission. On macOS the user
// sees the system prompt once; on Windows 10/11 it's silent (apps are
// pre-permitted via the manifest); on Linux it depends on the notification
// daemon (libnotify) — usually no prompt.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { getCurrentWindow } from '@tauri-apps/api/window'

interface NotifyOptions {
  title: string
  body: string
  /** Skip the focused-window check and notify regardless. Use sparingly —
   *  only for things the user explicitly opted in to (deploy succeeded,
   *  agent finished). Defaults to false. */
  evenWhenFocused?: boolean
  /** Optional dedup key — if set, suppresses repeats of the same key
   *  within `dedupWindowMs`. Useful for events that can fire in bursts. */
  dedupKey?: string
}

const DEDUP_WINDOW_MS = 5_000
const recentByKey = new Map<string, number>()

let cachedPermission: boolean | null = null

async function ensurePermission(): Promise<boolean> {
  if (cachedPermission !== null) return cachedPermission
  try {
    let granted = await isPermissionGranted()
    if (!granted) {
      const result = await requestPermission()
      granted = result === 'granted'
    }
    cachedPermission = granted
    return granted
  } catch {
    cachedPermission = false
    return false
  }
}

async function isWindowFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused()
  } catch {
    return false
  }
}

export async function notify(opts: NotifyOptions): Promise<void> {
  if (opts.dedupKey) {
    const last = recentByKey.get(opts.dedupKey)
    const now = Date.now()
    if (last && now - last < DEDUP_WINDOW_MS) return
    recentByKey.set(opts.dedupKey, now)
  }

  if (!opts.evenWhenFocused && (await isWindowFocused())) return

  if (!(await ensurePermission())) return

  try {
    sendNotification({ title: opts.title, body: opts.body })
  } catch {
    // The plugin throws on platforms where notifications aren't reachable
    // (e.g. WSL without a daemon). Silent failure is fine — it's a "nice
    // to have" channel, not a control flow signal.
  }
}
