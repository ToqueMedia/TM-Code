/**
 * GitHub OAuth Device Flow client (frontend half).
 *
 * Thin wrappers over the Rust `github_*` commands (see
 * `src-tauri/src/commands/github.rs`) plus `runDeviceFlow`, which drives the
 * poll loop: request a user code → caller shows it + opens the verify page →
 * poll until GitHub reports authorized / expired / denied. The access token
 * lives only in the Rust keychain; it never crosses into JS. We obtain it so a
 * private `git clone` can authenticate instead of hanging on an invisible
 * credential prompt.
 */
import { invoke } from '@/utils/invokeMetrics'

export interface DeviceCode {
  userCode: string
  deviceCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type PollStatus = 'authorized' | 'pending' | 'slow_down' | 'expired' | 'denied' | 'error'

export interface DevicePoll {
  status: PollStatus
  interval?: number
  message?: string
}

/** Terminal outcome of a full device-flow run. */
export type DeviceFlowResult = 'authorized' | 'expired' | 'denied' | 'error' | 'cancelled'

/** Step 1 — request a device + user code. */
export function githubDeviceStart(clientId: string, scope?: string): Promise<DeviceCode> {
  return invoke<DeviceCode>('github_device_start', { clientId, scope: scope ?? null })
}

/** Step 3 (single poll) — exchange the device code for a token, once. */
export function githubDevicePoll(clientId: string, deviceCode: string): Promise<DevicePoll> {
  return invoke<DevicePoll>('github_device_poll', { clientId, deviceCode })
}

/** Whether a GitHub token is currently stored in the keychain. */
export function githubTokenStatus(): Promise<boolean> {
  return invoke<boolean>('github_token_status')
}

/** Forget the stored GitHub token ("Disconnect"). */
export function githubDisconnect(): Promise<void> {
  return invoke<void>('github_disconnect')
}

/** Best-effort login of the connected account (for "Connected as @login"). */
export function githubAccount(): Promise<string | null> {
  return invoke<string | null>('github_account')
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Poll GitHub until the device flow reaches a terminal state. `cancel.cancelled`
 * is checked between polls so closing the dialog stops the loop promptly.
 * Honours GitHub's `interval` and `slow_down` back-pressure.
 */
export async function pollDeviceFlow(
  clientId: string,
  device: DeviceCode,
  cancel: { cancelled: boolean },
): Promise<DeviceFlowResult> {
  let intervalMs = Math.max(1, device.interval || 5) * 1000
  const deadline = Date.now() + Math.max(60, device.expiresIn || 900) * 1000

  while (!cancel.cancelled && Date.now() < deadline) {
    await sleep(intervalMs)
    if (cancel.cancelled) return 'cancelled'

    let poll: DevicePoll
    try {
      poll = await githubDevicePoll(clientId, device.deviceCode)
    } catch {
      // Transient network/IPC error — keep polling until the deadline.
      continue
    }

    switch (poll.status) {
      case 'authorized':
        return 'authorized'
      case 'expired':
        return 'expired'
      case 'denied':
        return 'denied'
      case 'slow_down':
        // GitHub asks us to back off; it bumps the interval by ~5s.
        intervalMs = Math.max(1, poll.interval ?? device.interval + 5) * 1000
        break
      case 'pending':
      case 'error':
      default:
        // Keep waiting (errors here are typically transient).
        break
    }
  }
  return cancel.cancelled ? 'cancelled' : 'expired'
}
