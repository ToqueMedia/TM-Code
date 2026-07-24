import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { IS_MAC } from '../utils/platform'
import { resolveOllamaUrl, getAutoSelectedOllamaUrls } from '../utils/devUrls'

export interface EditorIndentationSettings {
  tabSize: number
  insertSpaces: boolean
  detectIndentation: boolean
}

export interface AutocompleteSettings {
  enabled: boolean
  model: string
  ollamaUrl: string
}

// VS Code files.autoSave semantics: 'afterDelay' saves autoSaveDelay ms
// after the last edit; 'onFocusChange' saves when the editor/window loses
// focus; 'off' keeps explicit Cmd+S the only file-writing path.
export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange'
export const AUTO_SAVE_DELAY_MS = 1000

export const DEFAULT_CHAT_TEXT_FONT_SIZE = 14
export const CHAT_TEXT_FONT_SIZE_OPTIONS = [14, 16, 18, 20] as const
export type ChatTextFontSize = typeof CHAT_TEXT_FONT_SIZE_OPTIONS[number]

// AgentModelId removed — model selection moved to backend (decided by plan).
// Dead code reference for migration: was 'mimo-v2-flash' | 'deepseek-v3.2' | etc.

export type AppLanguage = 'en' | 'pt'
export type AgentLanguage = 'en' | 'pt' | 'zh' | 'es' | 'fr' | 'de' | 'ja'

export interface KeyBinding {
  key: string           // e.g. 'Enter', 'Escape', 'p'
  meta?: boolean        // Cmd (Mac) / Ctrl (Win)
  shift?: boolean
  alt?: boolean
}

export type ShortcutId =
  | 'toggleTerminal'
  | 'openFile'
  | 'newProject'
  | 'closeFile'
  | 'quickOpen'
  | 'commandPalette'
  | 'settings'
  | 'splitEditor'
  | 'toggleSidebar'
  | 'goToLine'
  | 'searchInProject'
  | 'diffAccept'
  | 'diffAcceptAll'
  | 'diffReject'
  | 'diffRejectAll'

export type ShortcutMap = Record<ShortcutId, KeyBinding | null>

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  toggleTerminal:   { key: '`', meta: true },
  openFile:         { key: 'o', meta: true },
  newProject:       { key: 'N', meta: true, shift: true },
  closeFile:        { key: 'w', meta: true },
  quickOpen:        { key: 'p', meta: true },
  commandPalette:   { key: 'p', meta: true, shift: true },
  settings:         { key: ',', meta: true },
  splitEditor:      { key: '\\', meta: true },
  toggleSidebar:    { key: 'b', meta: true },
  goToLine:         { key: 'g', meta: true },
  searchInProject:  { key: 'F', meta: true, shift: true },
  diffAccept:       { key: 'Enter', meta: true },
  diffAcceptAll:    { key: 'Enter', meta: true, shift: true },
  diffReject:       { key: 'Escape' },
  diffRejectAll:    { key: 'Escape', meta: true, shift: true },
}

interface SettingsState {
  editor: EditorIndentationSettings
  autocomplete: AutocompleteSettings
  formatOnSave: boolean
  autoSave: AutoSaveMode
  autoSaveDelay: number
  appLanguage: AppLanguage
  agentLanguage: AgentLanguage
  shortcuts: ShortcutMap
  hasCompletedOnboarding: boolean
  sandboxEnabled: boolean
  /** Fase 5 (multi-agente): isolar cada tarefa paralela num git worktree
   *  próprio (branch dedicada, merge deliberado — padrão Cursor/claude-vaz).
   *  DEFAULT ON por design (decisão do user 2026-07-16: git é requisito da
   *  IDE; sem repo, o sistema cria um local). O toggle fica como escape. */
  parallelTaskWorktrees: boolean
  /**
   * When true, refuse to open a project that another TM Code window already
   * holds a fresh lock for (no "Open anyway"). Default false — warning only.
   * ARCHITECTURE Current parallel model: optional hard lock.
   */
  hardBlockSecondProjectWindow: boolean
  chatTextFontSize: ChatTextFontSize
  /** Commands that require explicit developer approval every time the agent uses them.
   *  Empty by default (nothing blocked). User selects which commands to flag in Settings. */
  flaggedCommands: string[]
}

interface SettingsActions {
  setTabSize: (size: number) => void
  setInsertSpaces: (value: boolean) => void
  setDetectIndentation: (value: boolean) => void
  setAutocompleteEnabled: (enabled: boolean) => void
  setAutocompleteModel: (model: string) => void
  setAutocompleteOllamaUrl: (url: string) => void
  setSandboxEnabled: (enabled: boolean) => void
  setParallelTaskWorktrees: (enabled: boolean) => void
  setHardBlockSecondProjectWindow: (enabled: boolean) => void
  setFlaggedCommands: (commands: string[]) => void
  toggleFlaggedCommand: (command: string) => void
  setFormatOnSave: (value: boolean) => void
  setAutoSave: (mode: AutoSaveMode) => void
  setAppLanguage: (lang: AppLanguage) => void
  setAgentLanguage: (lang: AgentLanguage) => void
  setChatTextFontSize: (size: number) => void
  setShortcut: (id: ShortcutId, binding: KeyBinding) => void
  resetShortcuts: () => void
  completeOnboarding: () => void
}

const DEFAULTS: SettingsState = {
  editor: {
    tabSize: 2,
    insertSpaces: true,
    detectIndentation: true,
  },
  autocomplete: {
    enabled: true,
    model: 'qwen2.5-coder:7b',
    ollamaUrl: resolveOllamaUrl(),
  },
  formatOnSave: false,
  autoSave: 'afterDelay',
  autoSaveDelay: AUTO_SAVE_DELAY_MS,
  appLanguage: 'en',
  agentLanguage: 'en',
  shortcuts: { ...DEFAULT_SHORTCUTS },
  hasCompletedOnboarding: false,
  sandboxEnabled: false,
  parallelTaskWorktrees: true,
  hardBlockSecondProjectWindow: false,
  chatTextFontSize: DEFAULT_CHAT_TEXT_FONT_SIZE,
  flaggedCommands: [],
}

export const useSettingsStore = create<SettingsState & SettingsActions>()(
  persist(
    (set) => ({
      ...DEFAULTS,

      setTabSize: (size: number) => {
        const next = Math.max(1, Math.min(8, Math.floor(size)))
        set((state) => {
          return { editor: { ...state.editor, tabSize: next } }
        })
      },

      setInsertSpaces: (value: boolean) => {
        set((state) => {
          return { editor: { ...state.editor, insertSpaces: !!value } }
        })
      },

      setDetectIndentation: (value: boolean) => {
        set((state) => {
          return { editor: { ...state.editor, detectIndentation: !!value } }
        })
      },

      setAutocompleteEnabled: (enabled: boolean) => {
        // Reset error cooldown so completions start immediately
        if (enabled) {
          import('../services/aiCompletionService').then(({ default: Svc }) => {
            Svc.getInstance().resetCooldown()
          })
        }
        set((state) => ({
          autocomplete: { ...state.autocomplete, enabled }
        }))
      },

      setAutocompleteModel: (model: string) => {
        set((state) => ({
          autocomplete: { ...state.autocomplete, model }
        }))
      },

      setAutocompleteOllamaUrl: (url: string) => {
        // Only allow localhost or approved dev IPs to prevent exfiltration of code context
        try {
          const parsed = new URL(url)
          if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '192.168.64.1'].includes(parsed.hostname)) {
            return // reject non-approved URLs silently
          }
        } catch {
          return // reject invalid URLs
        }
        set((state) => ({
          autocomplete: { ...state.autocomplete, ollamaUrl: url }
        }))
      },

      setParallelTaskWorktrees: (enabled: boolean) => {
        set(() => ({ parallelTaskWorktrees: enabled }))
      },

      setHardBlockSecondProjectWindow: (enabled: boolean) => {
        set(() => ({ hardBlockSecondProjectWindow: enabled }))
      },

      setSandboxEnabled: (enabled: boolean) => {
        set(() => ({ sandboxEnabled: enabled }))
        // Sync to Rust backend
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('sandbox_set_enabled', { enabled }).catch(() => {})
        })
      },

      setFlaggedCommands: (commands: string[]) => {
        set(() => ({ flaggedCommands: commands }))
      },

      toggleFlaggedCommand: (command: string) => {
        set(state => {
          const current = state.flaggedCommands
          if (current.includes(command)) {
            return { flaggedCommands: current.filter(c => c !== command) }
          }
          return { flaggedCommands: [...current, command] }
        })
      },

      setFormatOnSave: (value: boolean) => {
        set(() => ({ formatOnSave: !!value }))
      },

      setAutoSave: (mode: AutoSaveMode) => {
        set(() => ({ autoSave: mode }))
      },

      setAppLanguage: (lang: AppLanguage) => {
        set(() => ({ appLanguage: lang }))
      },

      setAgentLanguage: (lang: AgentLanguage) => {
        set(() => ({ agentLanguage: lang }))
        // Invalidate cached system prompts so the next agent turn picks up
        // the new language immediately (without waiting for the 30s TTL).
        void import('../services/agent/contextBuilder').then(mod => {
          mod.default.getInstance().invalidatePromptCache()
        }).catch(() => { /* non-critical */ })
      },

      setChatTextFontSize: (size: number) => {
        set(() => ({ chatTextFontSize: normalizeChatTextFontSize(size) }))
      },

      setShortcut: (id: ShortcutId, binding: KeyBinding) => {
        set(state => {
          // Clear any conflicting shortcut (other action with the same binding)
          const updated = { ...state.shortcuts }
          for (const [otherId, otherBinding] of Object.entries(updated)) {
            if (otherId !== id && otherBinding && bindingsEqual(otherBinding, binding)) {
              updated[otherId as ShortcutId] = null
            }
          }
          updated[id] = binding
          return { shortcuts: updated }
        })
      },

      resetShortcuts: () => {
        set(() => ({ shortcuts: { ...DEFAULT_SHORTCUTS } }))
      },

      completeOnboarding: () => {
        set(() => ({ hasCompletedOnboarding: true }))
      },
    }),
    {
      name: 'settings-storage',
      partialize: (state) => {
        return { editor: state.editor, autocomplete: state.autocomplete, formatOnSave: state.formatOnSave, autoSave: state.autoSave, autoSaveDelay: state.autoSaveDelay, appLanguage: state.appLanguage, agentLanguage: state.agentLanguage, shortcuts: state.shortcuts, hasCompletedOnboarding: state.hasCompletedOnboarding, sandboxEnabled: state.sandboxEnabled, taskWorktreesV2: state.parallelTaskWorktrees, chatTextFontSize: state.chatTextFontSize, flaggedCommands: state.flaggedCommands }
      },
      // Deep merge — ensures new fields added to sub-objects get defaults
      merge: (persisted, current) => {
        const p = persisted as Partial<SettingsState>
        // Self-heal the ollamaUrl: if the persisted value is one the app
        // auto-selected in a prior run (and NOT a user override), recompute
        // from the current platform. This lets a user who switches Mac ↔
        // Windows pick up the right default without having to reset settings.
        const persistedOllama = p.autocomplete?.ollamaUrl
        const autoSelected = getAutoSelectedOllamaUrls()
        const ollamaUrl = persistedOllama && !autoSelected.has(persistedOllama)
          ? persistedOllama  // user override — preserve verbatim
          : resolveOllamaUrl()
        return {
          ...current,
          editor: { ...DEFAULTS.editor, ...p.editor },
          autocomplete: { ...DEFAULTS.autocomplete, ...p.autocomplete, ollamaUrl },
          formatOnSave: p.formatOnSave ?? DEFAULTS.formatOnSave,
          autoSave: p.autoSave === 'off' || p.autoSave === 'afterDelay' || p.autoSave === 'onFocusChange' ? p.autoSave : DEFAULTS.autoSave,
          autoSaveDelay: typeof p.autoSaveDelay === 'number' && Number.isFinite(p.autoSaveDelay) && p.autoSaveDelay >= 250 ? p.autoSaveDelay : DEFAULTS.autoSaveDelay,
          appLanguage: p.appLanguage ?? DEFAULTS.appLanguage,
          agentLanguage: p.agentLanguage ?? DEFAULTS.agentLanguage,
          hasCompletedOnboarding: p.hasCompletedOnboarding ?? DEFAULTS.hasCompletedOnboarding,
          sandboxEnabled: p.sandboxEnabled ?? DEFAULTS.sandboxEnabled,
          // Chave v2: o opt-in de horas antes persistiu false em máquinas de
          // teste — a chave nova ignora esse legado e nasce ON por design.
          parallelTaskWorktrees: (p as Record<string, unknown>).taskWorktreesV2 as boolean ?? DEFAULTS.parallelTaskWorktrees,
          chatTextFontSize: normalizeChatTextFontSize(p.chatTextFontSize),
          flaggedCommands: Array.isArray(p.flaggedCommands) ? p.flaggedCommands : DEFAULTS.flaggedCommands,
          // Merge shortcuts: defaults for new keys, but preserve null (cleared by conflict)
          shortcuts: Object.fromEntries(
            Object.keys(DEFAULT_SHORTCUTS).map(k => [
              k,
              p.shortcuts && k in p.shortcuts ? p.shortcuts[k as ShortcutId] : DEFAULT_SHORTCUTS[k as ShortcutId],
            ])
          ) as ShortcutMap,
        }
      },
    }
  )
)

function normalizeChatTextFontSize(size: unknown): ChatTextFontSize {
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return DEFAULT_CHAT_TEXT_FONT_SIZE
  }
  const rounded = Math.round(size)
  return (CHAT_TEXT_FONT_SIZE_OPTIONS as readonly number[]).includes(rounded)
    ? rounded as ChatTextFontSize
    : DEFAULT_CHAT_TEXT_FONT_SIZE
}

/** Check if two KeyBindings are equivalent */
function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
  return a.key === b.key
    && !!a.meta === !!b.meta
    && !!a.shift === !!b.shift
    && !!a.alt === !!b.alt
}

/** Check if a KeyboardEvent matches a KeyBinding. Returns false if binding is null/undefined (cleared by conflict). */
export function matchesBinding(e: KeyboardEvent, binding: KeyBinding | null | undefined): boolean {
  if (!binding) return false
  const meta = !!(binding.meta)
  const shift = !!(binding.shift)
  const alt = !!(binding.alt)

  if (meta !== (e.metaKey || e.ctrlKey)) return false
  if (shift !== e.shiftKey) return false
  if (alt !== e.altKey) return false

  // Match key (case-insensitive for letters, exact for special keys)
  const bKey = binding.key
  if (bKey.length === 1) {
    return e.key.toLowerCase() === bKey.toLowerCase() || e.code === `Key${bKey.toUpperCase()}`
  }
  return e.key === bKey || e.code === bKey
}

/** Format a KeyBinding for display (e.g. "⌘⇧↩") */
export function formatBinding(binding: KeyBinding | null | undefined): string {
  if (!binding) return '—'
  const isMac = IS_MAC
  const parts: string[] = []

  if (binding.meta) parts.push(isMac ? '⌘' : 'Ctrl')
  if (binding.shift) parts.push(isMac ? '⇧' : 'Shift')
  if (binding.alt) parts.push(isMac ? '⌥' : 'Alt')

  const keyMap: Record<string, string> = {
    Enter: isMac ? '↩' : 'Enter',
    Escape: 'Esc',
    Backquote: '`',
    Backslash: '\\',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  }
  parts.push(keyMap[binding.key] || binding.key.toUpperCase())

  return isMac ? parts.join('') : parts.join('+')
}
