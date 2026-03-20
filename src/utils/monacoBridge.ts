// src/utils/monacoBridge.ts
import type * as monaco from 'monaco-editor'

class MonacoBridge {
  private static instance: MonacoBridge
  private editor: monaco.editor.IStandaloneCodeEditor | null = null
  private _pendingReveal: { file: string; line: number; column: number } | null = null

  static getInstance(): MonacoBridge {
    if (!MonacoBridge.instance) MonacoBridge.instance = new MonacoBridge()
    return MonacoBridge.instance
  }

  setCurrentEditor(editor: monaco.editor.IStandaloneCodeEditor | null): void {
    this.editor = editor
  }

  getCurrentEditor(): monaco.editor.IStandaloneCodeEditor | null {
    return this.editor
  }

  trigger(commandId: string): void {
    try {
      if (this.editor) {
        ;(this.editor as unknown as { trigger(source: string, handlerId: string, payload: unknown): void })
          .trigger('monacoBridge', commandId, null)
      }
    } catch {}
  }

  /** Run a registered Monaco editor action by its ID (e.g. 'editor.action.gotoLine'). */
  runAction(actionId: string): void {
    try {
      const ed = this.editor
      if (!ed) return
      const action = ed.getAction(actionId)
      if (action) action.run().catch(() => {})
    } catch {}
  }

  /** Toggle a boolean sub-option (minimap.enabled, stickyScroll.enabled). */
  toggleOption(option: 'minimap' | 'stickyScroll'): void {
    if (!this.editor) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ed = this.editor as any
      const raw = ed.getRawOptions?.() ?? {}
      const enabled = raw[option]?.enabled ?? true
      ed.updateOptions({ [option]: { enabled: !enabled } })
    } catch {}
  }

  /** Store a position to reveal after a file is opened (for cross-file Go to Definition). */
  setPendingReveal(file: string, line: number, column: number): void {
    this._pendingReveal = { file, line, column }
  }

  /** Consume pending reveal if it matches the file path. Returns null if no match. */
  consumePendingReveal(file: string): { line: number; column: number } | null {
    if (this._pendingReveal && this._pendingReveal.file === file) {
      const pos = { line: this._pendingReveal.line, column: this._pendingReveal.column }
      this._pendingReveal = null
      return pos
    }
    return null
  }
}

export default MonacoBridge
