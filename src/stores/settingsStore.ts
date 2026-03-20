import { create } from 'zustand'
import { persist } from 'zustand/middleware'

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

interface SettingsState {
  editor: EditorIndentationSettings
  autocomplete: AutocompleteSettings
  formatOnSave: boolean
}

interface SettingsActions {
  setTabSize: (size: number) => void
  setInsertSpaces: (value: boolean) => void
  setDetectIndentation: (value: boolean) => void
  setAutocompleteEnabled: (enabled: boolean) => void
  setAutocompleteModel: (model: string) => void
  setAutocompleteOllamaUrl: (url: string) => void
  setFormatOnSave: (value: boolean) => void
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
    ollamaUrl: 'http://localhost:11434',
  },
  formatOnSave: false,
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
        set((state) => ({
          autocomplete: { ...state.autocomplete, ollamaUrl: url }
        }))
      },

      setFormatOnSave: (value: boolean) => {
        set(() => ({ formatOnSave: !!value }))
      },
    }),
    {
      name: 'settings-storage',
      partialize: (state) => {
        return { editor: state.editor, autocomplete: state.autocomplete, formatOnSave: state.formatOnSave }
      },
      // Deep merge — ensures new fields added to sub-objects get defaults
      merge: (persisted, current) => {
        const p = persisted as Partial<SettingsState>
        return {
          ...current,
          editor: { ...DEFAULTS.editor, ...p.editor },
          autocomplete: { ...DEFAULTS.autocomplete, ...p.autocomplete },
          formatOnSave: p.formatOnSave ?? DEFAULTS.formatOnSave,
        }
      },
    }
  )
)
