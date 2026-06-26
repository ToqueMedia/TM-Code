import { create } from 'zustand'
import { invoke } from '@/utils/invokeMetrics'
import { useLayoutStore, selectBackendUrl } from './layoutStore'

/**
 * Debounced write-through to app-managed per-project state. Subscribes to
 * the store's `(tabs, activeTabId, history)` triple at module init time
 * (see bottom of file) and queues a single save 800ms after the last
 * mutation lands. The store remains the live view; disk is just the
 * canonical snapshot for restart survival.
 *
 * 800ms picked empirically: long enough to coalesce a header-edit burst
 * (the user types a token char-by-char into an auth field) into one
 * write, short enough that closing the IDE after an edit still captures
 * it (the IDE's "are you sure you want to quit" path takes >1s anyway).
 */
const PERSIST_DEBOUNCE_MS = 800
let persistTimer: ReturnType<typeof setTimeout> | null = null
function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void Promise.all([
      import('./projectStore'),
      import('../services/httpClientPersistence'),
    ]).then(([{ useProjectStore }, { saveHttpClientToDisk }]) => {
      const path = useProjectStore.getState().currentProject?.path
      if (!path) return
      const s = useHttpClientStore.getState()
      void saveHttpClientToDisk(path, {
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        history: s.history,
      })
    }).catch(() => { /* persistence failure must not affect runtime */ })
  }, PERSIST_DEBOUNCE_MS)
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

export interface KeyValuePair {
  id: string
  key: string
  value: string
  enabled: boolean
}

export type AuthType = 'none' | 'bearer' | 'basic'

export interface AuthConfig {
  type: AuthType
  token: string
  username: string
  password: string
}

export type BodyType = 'json' | 'text' | 'form-urlencoded'

export interface HttpResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  headerEntries: [string, string][]
  body: string
  durationMs: number
  sizeBytes: number
}

interface RawHttpResponse {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
  durationMs: number
  sizeBytes: number
}

export interface HistoryEntry {
  id: string
  method: HttpMethod
  url: string
  status: number
  statusText: string
  durationMs: number
  timestamp: number
  headers: KeyValuePair[]
  params: KeyValuePair[]
  body: string
  bodyType: BodyType
  formData: KeyValuePair[]
  authType: AuthType
}

export type RequestTab = 'auth' | 'headers' | 'params' | 'body'

/** Per-request tab state */
export interface RequestState {
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
  response: HttpResponse | null
  isLoading: boolean
  error: string | null
  activeRequestTab: RequestTab
  activeResponseTab: 'body' | 'headers'
}

interface HttpClientState {
  tabs: RequestState[]
  activeTabId: string
  history: HistoryEntry[]
  isHistoryOpen: boolean
}

interface HttpClientActions {
  // Tab management
  addTab: () => void
  removeTab: (id: string) => void
  setActiveTab: (id: string) => void
  duplicateTab: (id: string) => void
  renameTab: (id: string, name: string) => void

  // Current-tab request editing
  setMethod: (method: HttpMethod) => void
  setUrl: (url: string) => void
  setBody: (body: string) => void
  setBodyType: (type: BodyType) => void
  formatJson: () => void
  setActiveRequestTab: (tab: RequestTab) => void
  setActiveResponseTab: (tab: 'body' | 'headers') => void
  setAuth: (auth: Partial<AuthConfig>) => void
  addHeader: () => void
  updateHeader: (id: string, field: 'key' | 'value' | 'enabled', val: string | boolean) => void
  removeHeader: (id: string) => void
  addParam: () => void
  updateParam: (id: string, field: 'key' | 'value' | 'enabled', val: string | boolean) => void
  removeParam: (id: string) => void
  addFormData: () => void
  updateFormData: (id: string, field: 'key' | 'value' | 'enabled', val: string | boolean) => void
  removeFormData: (id: string) => void
  sendRequest: () => Promise<void>
  clearResponse: () => void
  loadFromHistory: (entry: HistoryEntry) => void
  removeFromHistory: (id: string) => void
  clearHistory: () => void
  toggleHistory: () => void
  setBaseUrl: (url: string) => void
  resetForNewProject: () => void

  // Selectors (computed from active tab)
  getActiveTab: () => RequestState | undefined

  // Compat: flat selectors mapped from active tab (for components)
  readonly method: HttpMethod
  readonly url: string
  readonly headers: KeyValuePair[]
  readonly params: KeyValuePair[]
  readonly body: string
  readonly bodyType: BodyType
  readonly formData: KeyValuePair[]
  readonly auth: AuthConfig
  readonly response: HttpResponse | null
  readonly isLoading: boolean
  readonly error: string | null
  readonly activeRequestTab: RequestTab
  readonly activeResponseTab: 'body' | 'headers'
}

const createPair = (): KeyValuePair => ({
  id: crypto.randomUUID(),
  key: '',
  value: '',
  enabled: true,
})

const defaultAuth: AuthConfig = {
  type: 'none',
  token: '',
  username: '',
  password: '',
}

function createRequestTab(name?: string): RequestState {
  return {
    id: crypto.randomUUID(),
    name: name || 'New Request',
    method: 'GET',
    url: '/',
    headers: [createPair()],
    params: [createPair()],
    body: '',
    bodyType: 'json',
    formData: [createPair()],
    auth: { ...defaultAuth },
    response: null,
    isLoading: false,
    error: null,
    activeRequestTab: 'auth',
    activeResponseTab: 'body',
  }
}

const MAX_HISTORY = 50
const MAX_TABS = 15

let requestGeneration = 0

function hasHeaderCaseInsensitive(headers: Record<string, string>, key: string): boolean {
  const lower = key.toLowerCase()
  return Object.keys(headers).some(k => k.toLowerCase() === lower)
}

/** Helper: update the active tab's state immutably */
function updateActiveTab(
  state: HttpClientState,
  updater: (tab: RequestState) => Partial<RequestState>,
  extraState?: Partial<HttpClientState>,
): Partial<HttpClientState & HttpClientActions> {
  const tab = state.tabs.find(t => t.id === state.activeTabId)
  if (!tab) return {}
  const patch = updater(tab)
  const updated = { ...tab, ...patch }
  const tabs = state.tabs.map(t => t.id === state.activeTabId ? updated : t)
  return flattenState({ ...state, ...extraState, tabs })
}

/** Flattens active tab fields to top-level for compat with existing components */
function flattenState(state: HttpClientState): HttpClientState & Partial<HttpClientActions> {
  const tab = state.tabs.find(t => t.id === state.activeTabId) || state.tabs[0]
  if (!tab) return state as HttpClientState & Partial<HttpClientActions>
  return {
    ...state,
    method: tab.method,
    url: tab.url,
    headers: tab.headers,
    params: tab.params,
    body: tab.body,
    bodyType: tab.bodyType,
    formData: tab.formData,
    auth: tab.auth,
    response: tab.response,
    isLoading: tab.isLoading,
    error: tab.error,
    activeRequestTab: tab.activeRequestTab,
    activeResponseTab: tab.activeResponseTab,
  }
}

const initialTab = createRequestTab('Request 1')

export const useHttpClientStore = create<HttpClientState & HttpClientActions>()((set, get) => {
  /** Counter for default tab names */
  let tabCounter = 1

  return {
    // === State ===
    tabs: [initialTab],
    activeTabId: initialTab.id,
    history: [],
    isHistoryOpen: false,

    // Flat compat fields (from active tab)
    method: initialTab.method,
    url: initialTab.url,
    headers: initialTab.headers,
    params: initialTab.params,
    body: initialTab.body,
    bodyType: initialTab.bodyType,
    formData: initialTab.formData,
    auth: initialTab.auth,
    response: initialTab.response,
    isLoading: initialTab.isLoading,
    error: initialTab.error,
    activeRequestTab: initialTab.activeRequestTab,
    activeResponseTab: initialTab.activeResponseTab,

    // === Tab management ===

    addTab: () => {
      const state = get()
      if (state.tabs.length >= MAX_TABS) return
      tabCounter++
      const tab = createRequestTab(`Request ${tabCounter}`)
      const tabs = [...state.tabs, tab]
      set(flattenState({ ...state, tabs, activeTabId: tab.id }))
    },

    removeTab: (id) => {
      const state = get()
      if (state.tabs.length <= 1) return // keep at least one tab
      const idx = state.tabs.findIndex(t => t.id === id)
      const tabs = state.tabs.filter(t => t.id !== id)
      let activeTabId = state.activeTabId
      if (activeTabId === id) {
        // Switch to adjacent tab
        activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id || tabs[0].id
      }
      set(flattenState({ ...state, tabs, activeTabId }))
    },

    setActiveTab: (id) => {
      const state = get()
      if (state.activeTabId === id) return
      if (!state.tabs.find(t => t.id === id)) return
      set(flattenState({ ...state, activeTabId: id }))
    },

    duplicateTab: (id) => {
      const state = get()
      if (state.tabs.length >= MAX_TABS) return
      const source = state.tabs.find(t => t.id === id)
      if (!source) return
      tabCounter++
      const dup: RequestState = {
        ...source,
        id: crypto.randomUUID(),
        name: `${source.name} (copy)`,
        headers: source.headers.map(h => ({ ...h, id: crypto.randomUUID() })),
        params: source.params.map(p => ({ ...p, id: crypto.randomUUID() })),
        formData: source.formData.map(f => ({ ...f, id: crypto.randomUUID() })),
        auth: { ...source.auth },
        response: null,
        isLoading: false,
        error: null,
      }
      const idx = state.tabs.findIndex(t => t.id === id)
      const tabs = [...state.tabs]
      tabs.splice(idx + 1, 0, dup)
      set(flattenState({ ...state, tabs, activeTabId: dup.id }))
    },

    renameTab: (id, name) => set(s => {
      const tabs = s.tabs.map(t => t.id === id ? { ...t, name } : t)
      return flattenState({ ...s, tabs })
    }),

    // === Current-tab actions ===

    getActiveTab: () => {
      const s = get()
      return s.tabs.find(t => t.id === s.activeTabId)
    },

    setMethod: (method) => set(s => updateActiveTab(s, () => ({ method }))),
    setUrl: (url) => set(s => updateActiveTab(s, () => ({
      url: url.startsWith('/') ? url : '/' + url,
    }))),
    setBody: (body) => set(s => updateActiveTab(s, () => ({ body }))),
    setBodyType: (type) => set(s => updateActiveTab(s, () => ({ bodyType: type }))),
    formatJson: () => set(s => {
      const tab = s.tabs.find(t => t.id === s.activeTabId)
      if (!tab) return s
      try {
        const parsed = JSON.parse(tab.body)
        return updateActiveTab(s, () => ({ body: JSON.stringify(parsed, null, 2) }))
      } catch { return s }
    }),
    setActiveRequestTab: (tab) => set(s => updateActiveTab(s, () => ({ activeRequestTab: tab }))),
    setActiveResponseTab: (tab) => set(s => updateActiveTab(s, () => ({ activeResponseTab: tab }))),
    setAuth: (partial) => set(s => updateActiveTab(s, (t) => ({ auth: { ...t.auth, ...partial } }))),

    addHeader: () => set(s => updateActiveTab(s, (t) => ({ headers: [...t.headers, createPair()] }))),
    updateHeader: (id, field, val) => set(s => updateActiveTab(s, (t) => ({
      headers: t.headers.map(h => h.id === id ? { ...h, [field]: val } : h),
    }))),
    removeHeader: (id) => set(s => updateActiveTab(s, (t) => ({
      headers: t.headers.length > 1 ? t.headers.filter(h => h.id !== id) : t.headers,
    }))),

    addParam: () => set(s => updateActiveTab(s, (t) => ({ params: [...t.params, createPair()] }))),
    updateParam: (id, field, val) => set(s => updateActiveTab(s, (t) => ({
      params: t.params.map(p => p.id === id ? { ...p, [field]: val } : p),
    }))),
    removeParam: (id) => set(s => updateActiveTab(s, (t) => ({
      params: t.params.length > 1 ? t.params.filter(p => p.id !== id) : t.params,
    }))),

    addFormData: () => set(s => updateActiveTab(s, (t) => ({ formData: [...t.formData, createPair()] }))),
    updateFormData: (id, field, val) => set(s => updateActiveTab(s, (t) => ({
      formData: t.formData.map(f => f.id === id ? { ...f, [field]: val } : f),
    }))),
    removeFormData: (id) => set(s => updateActiveTab(s, (t) => ({
      formData: t.formData.length > 1 ? t.formData.filter(f => f.id !== id) : t.formData,
    }))),

    sendRequest: async () => {
      const state = get()
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab || !tab.url) return

      const gen = ++requestGeneration
      const tabId = tab.id
      set(s => updateActiveTab(s, () => ({ isLoading: true, error: null })))

      try {
        const baseUrl = selectBackendUrl(useLayoutStore.getState())
        let fullUrl = tab.url
        if (baseUrl && fullUrl.startsWith('/')) {
          fullUrl = baseUrl.replace(/\/$/, '') + fullUrl
        }

        if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
          throw new Error(`Invalid URL: "${fullUrl}". The dev server must be running.`)
        }

        const enabledParams = tab.params.filter(p => p.enabled && p.key)
        if (enabledParams.length > 0) {
          const searchParams = new URLSearchParams()
          enabledParams.forEach(p => searchParams.append(p.key, p.value))
          const separator = fullUrl.includes('?') ? '&' : '?'
          fullUrl += separator + searchParams.toString()
        }

        const headers: Record<string, string> = {}
        tab.headers.filter(h => h.enabled && h.key).forEach(h => {
          headers[h.key] = h.value
        })

        if (tab.auth.type === 'bearer' && tab.auth.token) {
          headers['Authorization'] = `Bearer ${tab.auth.token}`
        } else if (tab.auth.type === 'basic' && tab.auth.username) {
          const encoded = btoa(`${tab.auth.username}:${tab.auth.password}`)
          headers['Authorization'] = `Basic ${encoded}`
        }

        const hasBody = ['POST', 'PUT', 'PATCH'].includes(tab.method)
        let body: string | null = null

        if (hasBody) {
          if (tab.bodyType === 'form-urlencoded') {
            const formParams = new URLSearchParams()
            tab.formData.filter(f => f.enabled && f.key).forEach(f => {
              formParams.append(f.key, f.value)
            })
            body = formParams.toString()
          } else if (tab.body) {
            body = tab.body
          }

          if (body && !hasHeaderCaseInsensitive(headers, 'content-type')) {
            if (tab.bodyType === 'json') headers['Content-Type'] = 'application/json'
            else if (tab.bodyType === 'form-urlencoded') headers['Content-Type'] = 'application/x-www-form-urlencoded'
            else headers['Content-Type'] = 'text/plain'
          }
        }

        const raw = await invoke<RawHttpResponse>('http_client_request', {
          input: { method: tab.method, url: fullUrl, headers, body, timeoutSecs: 30 },
        })

        if (gen !== requestGeneration) return

        const headerMap: Record<string, string> = {}
        for (const [k, v] of raw.headers) {
          headerMap[k] = v
        }

        const response: HttpResponse = {
          status: raw.status,
          statusText: raw.statusText,
          headers: headerMap,
          headerEntries: raw.headers,
          body: raw.body,
          durationMs: raw.durationMs,
          sizeBytes: raw.sizeBytes,
        }

        const historyEntry: HistoryEntry = {
          id: crypto.randomUUID(),
          method: tab.method,
          url: tab.url,
          status: response.status,
          statusText: response.statusText,
          durationMs: response.durationMs,
          timestamp: Date.now(),
          headers: tab.headers.map(h => ({ ...h })),
          params: tab.params.map(p => ({ ...p })),
          body: tab.body,
          bodyType: tab.bodyType,
          formData: tab.formData.map(f => ({ ...f })),
          authType: tab.auth.type,
        }

        set(s => {
          const tabs = s.tabs.map(t => t.id === tabId ? { ...t, response, isLoading: false } : t)
          return flattenState({
            ...s,
            tabs,
            history: [historyEntry, ...s.history].slice(0, MAX_HISTORY),
          })
        })
      } catch (err) {
        if (gen !== requestGeneration) return
        set(s => {
          const tabs = s.tabs.map(t => t.id === tabId ? {
            ...t,
            isLoading: false,
            error: err instanceof Error ? err.message : String(err),
            response: null,
          } : t)
          return flattenState({ ...s, tabs })
        })
      }
    },

    clearResponse: () => set(s => updateActiveTab(s, () => ({ response: null, error: null }))),

    loadFromHistory: (entry) => set(s => updateActiveTab(s, () => ({
      method: entry.method,
      url: entry.url,
      headers: entry.headers.length > 0 ? entry.headers.map(h => ({ ...h })) : [createPair()],
      params: entry.params.length > 0 ? entry.params.map(p => ({ ...p })) : [createPair()],
      body: entry.body,
      bodyType: entry.bodyType,
      formData: entry.formData?.length > 0 ? entry.formData.map(f => ({ ...f })) : [createPair()],
      auth: { ...defaultAuth, type: entry.authType },
    }), { isHistoryOpen: false })),

    removeFromHistory: (id) => set(s => ({
      history: s.history.filter(h => h.id !== id),
    })),

    clearHistory: () => set({ history: [] }),
    toggleHistory: () => set(s => ({ isHistoryOpen: !s.isHistoryOpen })),

    setBaseUrl: (_url) => {
      const tab = get().getActiveTab()
      if (tab && (tab.url === '' || tab.url === '/')) {
        set(s => updateActiveTab(s, () => ({ url: '/' })))
      }
    },

    resetForNewProject: () => {
      tabCounter = 1
      const tab = createRequestTab('Request 1')
      set(flattenState({
        tabs: [tab],
        activeTabId: tab.id,
        history: [],
        isHistoryOpen: false,
      }))
    },
  }
})

/**
 * Replace the live store with state loaded from disk. Called from
 * `projectStore.openProject` after the project path is set, so the user's
 * tabs/history from the previous session reappear on reopen. Exported as
 * a module function (not a store action) so the projectStore hook can
 * call it with a single import.
 */
export function hydrateHttpClientFromDisk(loaded: {
  tabs: RequestState[]
  activeTabId: string
  history: HistoryEntry[]
}): void {
  useHttpClientStore.setState(flattenState({
    tabs: loaded.tabs,
    activeTabId: loaded.activeTabId,
    history: loaded.history,
    isHistoryOpen: false,
  }))
}

// ── Persistence subscribe ────────────────────────────────────────────
//
// Watch `(tabs, activeTabId, history)` and trigger a debounced save on any
// change. We skip the `response`/`isLoading`/`error` fields explicitly
// because they fire on every send and would burn writes without changing
// the persisted shape (those fields are stripped by `saveHttpClientToDisk`).
//
// Module-scope subscribe runs once at import time — every store instance
// uses the same singleton, so this is fine. If the store is ever made
// per-project (it isn't today), this hook would need to move.
let _lastSig = ''
useHttpClientStore.subscribe((state) => {
  // Cheap signature — counts + IDs. Avoids deep-equal on large bodies.
  const sig = `${state.tabs.length}:${state.activeTabId}:${state.history.length}:${state.tabs.map(t => `${t.id}.${t.method}.${t.url.length}.${t.body.length}`).join('|')}`
  if (sig === _lastSig) return
  _lastSig = sig
  schedulePersist()
})
