import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface EditorIndentationSettings {
  tabSize: number
  insertSpaces: boolean
  detectIndentation: boolean
}

interface SettingsState {
  editor: EditorIndentationSettings
}

interface SettingsActions {
  setTabSize: (size: number) => void
  setInsertSpaces: (value: boolean) => void
  setDetectIndentation: (value: boolean) => void
}

export const useSettingsStore = create<SettingsState & SettingsActions>()(
  persist(
    (set, get) => ({
      editor: {
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: true,
      },

      setTabSize: (size: number) => {
        const next = Math.max(1, Math.min(8, Math.floor(size)))
        set(function (state) {
          return { editor: { ...state.editor, tabSize: next } }
        })
      },

      setInsertSpaces: (value: boolean) => {
        set(function (state) {
          return { editor: { ...state.editor, insertSpaces: !!value } }
        })
      },

      setDetectIndentation: (value: boolean) => {
        set(function (state) {
          return { editor: { ...state.editor, detectIndentation: !!value } }
        })
      },
    }),
    {
      name: 'settings-storage',
      partialize: function (state) {
        return { editor: state.editor }
      },
    }
  )
)