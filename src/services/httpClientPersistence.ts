/**
 * Per-project HTTP Client state persistence.
 *
 * The HTTP Client is marketed as a Postman-like surface. Postman persists
 * its requests, collections, and history. Without disk persistence the
 * IDE quietly breaks that promise — every restart drops the tabs the
 * developer was working on, history disappears, and a 30-minute debugging
 * session of incremental request-tuning is lost.
 *
 * State persisted in app-managed per-project state:
 *   - `tabs` — the request bodies, headers, params, form-data, auth.
 *     We strip `response`, `isLoading`, and `error` before writing —
 *     those are transient runtime fields that aren't meaningful after a
 *     restart (the response is from a long-dead dev server).
 *   - `activeTabId` — so the same tab is selected on reopen.
 *   - `history` — last 50 sent requests with their status code +
 *     duration, for the history panel.
 *
 * Loaded at project open by `projectStore.openProject`. Saved on a debounce
 * after meaningful mutations (URL change, header edit, send, history
 * removal) to avoid I/O on every keystroke.
 */

import { invoke } from '@tauri-apps/api/core'
import type {
  AuthConfig,
  BodyType,
  HistoryEntry,
  HttpMethod,
  KeyValuePair,
  RequestState,
  RequestTab,
} from '../stores/httpClientStore'

const HTTP_CLIENT_FILENAME = 'http-client.json'

/** Persisted shape of a request tab — `response`/`isLoading`/`error` stripped. */
interface PersistedTab {
  id: string
  name: string
  method: HttpMethod
  url: string
  headers: KeyValuePair[]
  params: KeyValuePair[]
  body: string
  bodyType: BodyType
  formData: KeyValuePair[]
  auth: AuthConfig
  activeRequestTab: RequestTab
  activeResponseTab: 'body' | 'headers'
}

interface HttpClientFileV1 {
  /** Schema version — bumped if the on-disk shape ever changes. */
  schemaVersion: 1
  /** ISO timestamp of the last write. */
  updatedAt: string
  tabs: PersistedTab[]
  activeTabId: string
  history: HistoryEntry[]
}

export interface LoadedHttpClientState {
  tabs: RequestState[]
  activeTabId: string
  history: HistoryEntry[]
}

/**
 * Strip the persisted shape into a full `RequestState`, re-initialising
 * the transient fields with their default empty state.
 */
function rehydrateTab(p: PersistedTab): RequestState {
  return {
    ...p,
    response: null,
    isLoading: false,
    error: null,
  }
}

/**
 * Read HTTP Client state for a project. Returns `null` when the file is
 * missing or invalid — the store keeps its default single-tab state.
 */
export async function loadHttpClientFromDisk(
  projectPath: string,
): Promise<LoadedHttpClientState | null> {
  if (!projectPath) return null
  try {
    const raw = await invoke<string | null>('read_agent_state', {
      projectPath,
      filename: HTTP_CLIENT_FILENAME,
    })
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<HttpClientFileV1>
    if (
      !parsed ||
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.tabs) ||
      !Array.isArray(parsed.history) ||
      typeof parsed.activeTabId !== 'string'
    ) {
      console.warn('[httpClientPersistence] http-client.json present but unrecognised; ignoring')
      return null
    }
    // Defensive coercion: a single bad tab shouldn't wedge the whole file.
    const tabs = parsed.tabs
      .filter((t): t is PersistedTab =>
        !!t && typeof t.id === 'string' && typeof t.url === 'string',
      )
      .map(rehydrateTab)
    if (tabs.length === 0) return null
    // If the saved `activeTabId` no longer matches any tab (corruption
    // edge case), fall back to the first tab so the UI lands on something
    // valid rather than getting a blank panel.
    const activeTabId = tabs.find(t => t.id === parsed.activeTabId)?.id ?? tabs[0].id
    return { tabs, activeTabId, history: parsed.history }
  } catch (err) {
    console.warn('[httpClientPersistence] failed to read http-client.json:', err)
    return null
  }
}

/**
 * Write HTTP Client state to disk. Strips transient fields (`response`,
 * `isLoading`, `error`) so the JSON stays small and reload-meaningful.
 */
export async function saveHttpClientToDisk(
  projectPath: string,
  state: {
    tabs: RequestState[]
    activeTabId: string
    history: HistoryEntry[]
  },
): Promise<void> {
  if (!projectPath) return
  const payload: HttpClientFileV1 = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    tabs: state.tabs.map(t => ({
      id: t.id,
      name: t.name,
      method: t.method,
      url: t.url,
      headers: t.headers,
      params: t.params,
      body: t.body,
      bodyType: t.bodyType,
      formData: t.formData,
      auth: t.auth,
      activeRequestTab: t.activeRequestTab,
      activeResponseTab: t.activeResponseTab,
    })),
    activeTabId: state.activeTabId,
    history: state.history,
  }
  try {
    await invoke('write_agent_state', {
      projectPath,
      filename: HTTP_CLIENT_FILENAME,
      content: JSON.stringify(payload, null, 2),
    })
  } catch (err) {
    console.warn('[httpClientPersistence] failed to write http-client.json:', err)
  }
}
