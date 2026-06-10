import { getVersion } from '@tauri-apps/api/app'

const STORAGE_KEY_PREFIX = 'tmcode-installed-version'

export type WriteInstalledVersion = (version: string) => Promise<void>

export function getInstalledVersionStorageKey(uid: string): string {
  return `${STORAGE_KEY_PREFIX}:${uid}`
}

function readStoredVersion(uid: string): string | null {
  try {
    return window.localStorage.getItem(getInstalledVersionStorageKey(uid))
  } catch {
    return null
  }
}

function writeStoredVersion(uid: string, version: string): void {
  try {
    window.localStorage.setItem(getInstalledVersionStorageKey(uid), version)
  } catch {
    // Storage can be unavailable in restricted WebViews; Firestore sync still succeeded.
  }
}

/**
 * Syncs the installed TM Code version once per user/version pair.
 * localStorage acts as the local acknowledgement that Firestore already has
 * this version for this user, so it is updated only after the remote write.
 */
export async function syncInstalledTmCodeVersion(
  uid: string,
  writeInstalledVersion: WriteInstalledVersion
): Promise<string | null> {
  const currentVersion = await getVersion()
  if (!currentVersion) return null

  const storedVersion = readStoredVersion(uid)
  if (storedVersion === currentVersion) {
    return currentVersion
  }

  await writeInstalledVersion(currentVersion)
  writeStoredVersion(uid, currentVersion)
  return currentVersion
}
