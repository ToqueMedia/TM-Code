import { invoke } from '@/utils/invokeMetrics'

// Thin invoke wrappers over the Rust `collab`/`tunnel` commands: team chat
// persistence + the live-preview tunnel's sharer-side fetch.
export class CollabService {
  /// Live-preview tunnel — fetch the sharer's local dev server (binary-safe).
  static tunnelFetch(
    url: string,
    method: string,
    headers: [string, string][],
    bodyBase64?: string,
  ): Promise<{ status: number; headers: [string, string][]; bodyBase64: string }> {
    return invoke('tunnel_fetch', { input: { url, method, headers, bodyBase64: bodyBase64 ?? null } })
  }

  /// Append one serialized chat message (a JSON line) to the local chat log.
  /// Best-effort — never throws (chat still works in-memory if the write fails).
  static async chatAppend(projectPath: string, line: string): Promise<void> {
    try {
      await invoke('collab_chat_append', { projectPath, line })
    } catch (e) {
      console.warn('[CollabService] chatAppend failed:', e)
    }
  }

  /// Load the last `limit` persisted chat lines (0 = no cap). Best-effort.
  static async chatLoad(projectPath: string, limit = 200): Promise<string[]> {
    try {
      return await invoke<string[]>('collab_chat_load', { projectPath, limit })
    } catch {
      return []
    }
  }
}
