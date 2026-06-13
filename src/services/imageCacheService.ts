/**
 * Pasted-image disk cache — lets the agent re-view a pasted image across app
 * restarts / session reloads without the user re-sending it.
 *
 * The problem (context audit, 2026-06): pasted images live only as in-memory
 * base64; sessionService strips that base64 on persist to keep session files
 * small, and a pasted image has no `path`, so after reload there is nothing to
 * re-resolve from — the image is gone.
 *
 * The fix (port of claude-vaz utils/imageStore.ts): decode the base64 to a
 * real file under `<appData>/image-cache/<sessionId>/<attachmentId>.<ext>` and
 * stamp that path onto the attachment. resolveImageToDataUri already has a
 * "read from disk via att.path" slow path, so reload re-resolution then works
 * with no further changes.
 *
 * Scope is per-session (user choice, 2026-06-13): images survive restart for
 * the SAME conversation; a session's cache dir is removed when that session is
 * deleted. The fs:scope capability allows the app-data dir (APPDATA), so
 * plugin-fs read/write/mkdir/remove on these absolute paths is permitted.
 */
import type { Attachment } from '../types/chat'
import { logger } from '../utils/logger'

const IMAGE_CACHE_DIRNAME = 'image-cache'

/** data URI → raw bytes. Returns null when the string isn't a base64 data URI. */
function dataUriToBytes(dataUri: string): Uint8Array | null {
  const comma = dataUri.indexOf(',')
  if (!dataUri.startsWith('data:') || comma === -1) return null
  try {
    const b64 = dataUri.slice(comma + 1)
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function extFromAttachment(att: Attachment): string {
  const fromName = att.name.includes('.') ? att.name.split('.').pop()!.toLowerCase() : ''
  if (fromName) return fromName === 'jpeg' ? 'jpg' : fromName
  const fromMime = att.mimeType?.split('/')[1]?.replace('jpeg', 'jpg')
  return fromMime || 'png'
}

async function cacheBaseDir(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path')
  return join(await appDataDir(), IMAGE_CACHE_DIRNAME)
}

/**
 * Persist any in-memory pasted images on `attachments` to the session's disk
 * cache. Returns a map of attachmentId → absolute path for the images written,
 * so the caller can stamp the path back onto the stored attachments. Images
 * that already have a `path`, non-images, and base64-less attachments are
 * skipped. Never throws — a cache miss just means the old (re-send) behaviour.
 */
export async function storeSessionImages(
  sessionId: string,
  attachments: Attachment[] | undefined,
): Promise<Record<string, string>> {
  if (!sessionId || !attachments?.length) return {}
  const pasted = attachments.filter(
    a => a.type === 'image' && !a.path && a.base64?.startsWith('data:'),
  )
  if (pasted.length === 0) return {}

  const result: Record<string, string> = {}
  try {
    const { mkdir, writeFile } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    const dir = await join(await cacheBaseDir(), sessionId)
    await mkdir(dir, { recursive: true })

    for (const att of pasted) {
      const bytes = dataUriToBytes(att.base64!)
      if (!bytes) continue
      const filePath = await join(dir, `${att.id}.${extFromAttachment(att)}`)
      try {
        await writeFile(filePath, bytes)
        result[att.id] = filePath
      } catch (e) {
        logger.warn('image-cache', `failed to write image ${att.id}`, e)
      }
    }
  } catch (e) {
    logger.warn('image-cache', 'storeSessionImages failed', e)
  }
  return result
}

/** Remove one session's image cache directory (call when the session is deleted). */
export async function removeSessionImageCache(sessionId: string): Promise<void> {
  if (!sessionId) return
  try {
    const { remove } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    const dir = await join(await cacheBaseDir(), sessionId)
    await remove(dir, { recursive: true })
  } catch {
    /* dir may not exist — fine */
  }
}
