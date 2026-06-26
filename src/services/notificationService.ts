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

/**
 * Public entry point to trigger the OS notification-permission dialog at a
 * moment the user expects it. Onboarding is the obvious place — the user is
 * configuring the IDE, the prompt is contextual instead of arriving later
 * when the agent unexpectedly wants to notify them about something else.
 *
 * Idempotent: the result is cached, so calling this from multiple places
 * (e.g. onboarding ReadyStep mount + first notify) only ever shows the OS
 * dialog once.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  return ensurePermission()
}

async function isWindowFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused()
  } catch {
    return false
  }
}

/**
 * Translate an internal tool identifier into a user-readable verb phrase
 * suitable for OS notifications and toast messages. The notification
 * surface is consumer-grade — it has to make sense to someone who doesn't
 * know what `mcp__github__create_issue` means.
 *
 * Falls back to a tidied version of the raw id (mcp/MCP namespace stripped,
 * underscores → spaces) when no specific entry matches.
 */
export function humaniseToolName(toolName: string): string {
  const map: Record<string, string> = {
    write_file: 'edit a file',
    read_file: 'read a file',
    create_file: 'create a file',
    delete_file_or_directory: 'delete a file or folder',
    rename_file_or_directory: 'rename a file or folder',
    copy_file_or_directory: 'copy a file or folder',
    create_directories_all: 'create folders',
    execute_command: 'run a shell command',
    run_streaming_command: 'run a shell command',
    start_dev_server: 'start the dev server',
    stop_dev_server: 'stop the dev server',
    kill_process: 'stop a process',
    git_commit: 'commit changes',
    git_push: 'push to git remote',
    git_pull: 'pull from git remote',
    search_in_files: 'search in files',
    replace_in_files: 'replace across files',
  }
  if (map[toolName]) return map[toolName]
  // mcp__github__create_issue → "create issue (github)"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    if (parts.length >= 3) {
      const provider = parts[1]
      const action = parts.slice(2).join(' ').replace(/_/g, ' ')
      return `${action} (${provider})`
    }
  }
  return toolName.replace(/_/g, ' ')
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
