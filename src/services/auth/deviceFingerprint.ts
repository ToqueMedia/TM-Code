import { invoke } from '@tauri-apps/api/core'

let cached: string | null = null

/**
 * Returns a stable hash that identifies this physical machine. Backed by
 * machine-uid in Rust (see src-tauri/src/commands/device.rs) — survives
 * app reinstalls and most user-data wipes. Hashed so the raw machine UUID
 * never leaves the device.
 *
 * Cached in-memory for the session — the value cannot change at runtime
 * and the IPC round-trip is wasted on every call.
 */
export async function getDeviceFingerprint(): Promise<string> {
  if (cached) return cached
  cached = await invoke<string>('get_device_fingerprint')
  return cached
}
