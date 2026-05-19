/**
 * Per-session draft persistence.
 *
 * A draft = whatever the user has typed (or pasted as an attachment) into
 * the prompt bar but **not yet submitted**. Without disk persistence, a
 * draft vanishes whenever the app reloads / crashes / loses focus during
 * an OS update — the most demoralising data-loss mode in a desktop IDE:
 * "I typed three paragraphs and lost it."
 *
 * Storage: `<project>/.toquemedia/sessions/<sessionId>.draft.json`.
 * Co-located with the session's main JSON. Gitignored (the
 * `.toquemedia/sessions/` entry in `.gitignore` covers it).
 *
 * Lifecycle:
 *   - Created/updated on every `setDraftInput` / draft-attachment mutation,
 *     debounced 600ms (the user types char-by-char; 600ms coalesces a
 *     burst into one write).
 *   - Read on `setActiveSession` so switching back to a session restores
 *     the in-progress prompt.
 *   - Deleted on submit (the prompt was sent — no draft to keep).
 *
 * Empty drafts (no text AND no attachments) trigger a delete rather than
 * an empty-file write, so `.toquemedia/sessions/` stays clean.
 */

import { invoke } from '@tauri-apps/api/core'
import type { Attachment } from '../types/chat'

interface DraftFileV1 {
  schemaVersion: 1
  updatedAt: string
  input: string
  attachments: Attachment[]
}

function draftPath(projectPath: string, sessionId: string): string {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  return `${normalized}/.toquemedia/sessions/${sessionId}.draft.json`
}

export interface LoadedDraft {
  input: string
  attachments: Attachment[]
}

/**
 * Read a session draft from disk. Returns `null` when no draft exists
 * (clean state) or when the file is unparseable. Never throws.
 */
export async function loadDraftFromDisk(
  projectPath: string,
  sessionId: string,
): Promise<LoadedDraft | null> {
  if (!projectPath || !sessionId) return null
  try {
    const raw = await invoke<string>('read_file', {
      path: draftPath(projectPath, sessionId),
    })
    const parsed = JSON.parse(raw) as Partial<DraftFileV1>
    if (!parsed || parsed.schemaVersion !== 1) return null
    return {
      input: typeof parsed.input === 'string' ? parsed.input : '',
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
    }
  } catch {
    // File missing OR read/parse error — both treated as "no draft".
    return null
  }
}

/**
 * Persist a session draft. When the draft is effectively empty (no text,
 * no attachments), the file is DELETED instead — this prevents a long
 * trail of empty `*.draft.json` files accumulating in
 * `.toquemedia/sessions/` for every session the user ever opened.
 *
 * Failures are swallowed; persistence is best-effort, the live store
 * stays the source of truth either way.
 */
export async function saveDraftToDisk(
  projectPath: string,
  sessionId: string,
  draft: { input: string; attachments: Attachment[] },
): Promise<void> {
  if (!projectPath || !sessionId) return
  const path = draftPath(projectPath, sessionId)
  const isEmpty = !draft.input.trim() && draft.attachments.length === 0

  if (isEmpty) {
    // Delete the draft file. The Tauri command returns NotFound silently,
    // so calling delete on an already-absent file is a cheap no-op — no
    // need to probe with read_file first.
    try {
      await invoke('delete_file_or_directory', { path })
    } catch { /* swallow */ }
    return
  }

  const payload: DraftFileV1 = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    input: draft.input,
    attachments: draft.attachments,
  }
  try {
    await invoke('write_file', {
      path,
      content: JSON.stringify(payload, null, 2),
    })
  } catch {
    // Swallow — the in-memory store remains the live source.
  }
}

/**
 * Delete the draft file explicitly (called on submit). Separate from
 * `saveDraftToDisk` even though both end up calling delete for empty
 * drafts — `clearDraftOnDisk` reflects the explicit "I sent the prompt"
 * intent, whereas an empty save could just mean "user cleared the input".
 * The behaviour is the same but the call site reads correctly.
 */
export async function clearDraftOnDisk(
  projectPath: string,
  sessionId: string,
): Promise<void> {
  if (!projectPath || !sessionId) return
  try {
    await invoke('delete_file_or_directory', {
      path: draftPath(projectPath, sessionId),
    })
  } catch { /* swallow */ }
}
