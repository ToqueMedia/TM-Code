// src/utils/monacoBridge.ts
import type * as monaco from 'monaco-editor'

class MonacoBridge {
  private static instance: MonacoBridge
  private editor: monaco.editor.IStandaloneCodeEditor | null = null

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
        // @ts-ignore
        this.editor.trigger('monacoBridge', commandId, null)
      }
    } catch {}
  }
}

export default MonacoBridge
