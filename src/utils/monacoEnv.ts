// src/utils/monacoEnv.ts
// Ensure Monaco web workers are configured before any model creation

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker
    }
  }
}

if (typeof window !== 'undefined') {
  // Only set once
  if (!window.MonacoEnvironment) {
    window.MonacoEnvironment = {
      getWorker: function (_workerId: string, label: string) {
        switch (label) {
          case 'json':
            return new jsonWorker()
          case 'css':
          case 'scss':
          case 'less':
            return new cssWorker()
          case 'html':
          case 'handlebars':
          case 'razor':
            return new htmlWorker()
          case 'typescript':
          case 'javascript':
            return new tsWorker()
          default:
            return new editorWorker()
        }
      }
    }
  }
}
