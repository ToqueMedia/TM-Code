import React, { useRef, useEffect } from 'react'
import * as monacoEditor from 'monaco-editor'
import type { editor } from 'monaco-editor'
import { tokens } from '@/theme/tokens'
import { toqueMediaTheme, toqueMediaSoftTheme } from '../../themes/toqueMediaTheme'

let diffThemesRegistered = false

interface MonacoDiffEditorProps {
  originalContent: string
  modifiedContent: string
  language: string
  originalPath: string
  modifiedPath: string
}

const MonacoDiffEditor: React.FC<MonacoDiffEditorProps> = ({
  originalContent,
  modifiedContent,
  language,
  originalPath,
  modifiedPath,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const diffEditorRef = useRef<editor.IDiffEditor | null>(null)
  const originalModelRef = useRef<editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<editor.ITextModel | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    // Register themes once
    if (!diffThemesRegistered) {
      diffThemesRegistered = true
      monacoEditor.editor.defineTheme('toquemedia-vibrant', toqueMediaTheme)
      monacoEditor.editor.defineTheme('toquemedia-soft', toqueMediaSoftTheme)
    }

    // Create unique URIs to avoid model conflicts
    const ts = Date.now()
    const originalModel = monacoEditor.editor.createModel(
      originalContent,
      language,
      monacoEditor.Uri.parse(`diff-original://${ts}/${originalPath}`)
    )
    const modifiedModel = monacoEditor.editor.createModel(
      modifiedContent,
      language,
      monacoEditor.Uri.parse(`diff-modified://${ts}/${modifiedPath}`)
    )

    originalModelRef.current = originalModel
    modifiedModelRef.current = modifiedModel

    const diffEditor = monacoEditor.editor.createDiffEditor(containerRef.current, {
      automaticLayout: true,
      theme: 'toquemedia-vibrant',
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      enableSplitViewResizing: true,
      fontSize: 13.5,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", Monaco, Menlo, monospace',
      fontLigatures: true,
      fontWeight: '400',
      lineHeight: 22,
      letterSpacing: 0,
      padding: { top: 8, bottom: 8 },
      minimap: { enabled: false },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
      overviewRulerBorder: false,
      renderLineHighlight: 'all',
      lineNumbers: 'on',
      lineNumbersMinChars: 4,
      glyphMargin: false,
      folding: true,
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      bracketPairColorization: { enabled: true },
      stickyScroll: { enabled: false },
      renderWhitespace: 'selection',
      contextmenu: false,
    })

    diffEditor.setModel({ original: originalModel, modified: modifiedModel })
    diffEditorRef.current = diffEditor

    // Cleanup — dispose in correct order: models BEFORE editor
    return () => {
      diffEditorRef.current = null
      diffEditor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
      originalModelRef.current = null
      modifiedModelRef.current = null
    }
  }, [originalContent, modifiedContent, language, originalPath, modifiedPath])

  return (
    <div
      ref={containerRef}
      style={{
        height: '100%',
        width: '100%',
        background: tokens.colors.bg.app,
      }}
    />
  )
}

export default MonacoDiffEditor
