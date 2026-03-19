import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import type { editor, IDisposable } from 'monaco-editor';
import { tokens } from '@/theme/tokens';
import { logger } from '../../utils/logger';
import MonacoBridge from '../../utils/monacoBridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { useEditorRepository } from '../../stores/editorStore';
import { toqueMediaTheme, toqueMediaSoftTheme } from '../../themes/toqueMediaTheme';

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker };
  }
}

if (typeof window !== 'undefined' && !window.MonacoEnvironment) {
  window.MonacoEnvironment = {
    getWorker(_id: string, label: string) {
      switch (label) {
        case 'json': return new jsonWorker();
        case 'css': case 'scss': case 'less': return new cssWorker();
        case 'html': case 'handlebars': case 'razor': return new htmlWorker();
        case 'typescript': case 'javascript': return new tsWorker();
        default: return new editorWorker();
      }
    }
  };
}

let themesRegistered = false;

function pushContentToStore(path: string, content: string) {
  try {
    const store = useEditorRepository.getState();
    const file = store.openFiles.find(f => f.path === path);
    if (file && file.content !== content) {
      store.updateFileContent(path, content);
    }
  } catch {}
}

interface MonacoEditorProps {
  path: string;
  onCursorPositionChange?: (line: number, column: number) => void;
}

const MonacoEditor: React.FC<MonacoEditorProps> = ({ path, onCursorPositionChange }) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const pathRef = useRef(path);
  const dirtyRef = useRef(false);
  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);
  const cursorCbRef = useRef(onCursorPositionChange);
  // Captured content — updated on every edit, survives editor disposal
  const pendingRef = useRef<{ path: string; content: string } | null>(null);

  cursorCbRef.current = onCursorPositionChange;
  pathRef.current = path;

  const tabSize = useSettingsStore(s => s.editor.tabSize);
  const insertSpaces = useSettingsStore(s => s.editor.insertSpaces);
  const detectIndentation = useSettingsStore(s => s.editor.detectIndentation);

  const options = useMemo((): editor.IStandaloneEditorConstructionOptions => ({
    automaticLayout: true,
    fontSize: 14,
    fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
    lineHeight: 20,
    tabSize, insertSpaces, detectIndentation,
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    padding: { top: 8, bottom: 8 },
    minimap: {
      enabled: true,
      side: 'right',
      showSlider: 'mouseover',
      renderCharacters: false,
      maxColumn: 80,
      scale: 1,
    },
    scrollbar: {
      verticalScrollbarSize: 8,
      horizontalScrollbarSize: 8,
      useShadows: false,
      verticalHasArrows: false,
      horizontalHasArrows: false,
    },
    overviewRulerBorder: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    cursorWidth: 2,
    bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
    guides: { bracketPairs: 'active', indentation: true, highlightActiveIndentation: true },
    folding: true,
    foldingHighlight: true,
    showFoldingControls: 'mouseover',
    matchBrackets: 'always',
    autoIndent: 'full',
    codeLens: false,
    renderLineHighlight: 'gutter',
    lineNumbers: 'on',
    glyphMargin: false,
    lineDecorationsWidth: 8,
    lineNumbersMinChars: 3,
    contextmenu: true,
    smoothScrolling: true,
    quickSuggestions: { other: 'on', comments: 'on', strings: 'on' },
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnEnter: 'on',
    snippetSuggestions: 'inline',
    formatOnPaste: false,
    formatOnType: false,
    renderWhitespace: 'none',
    links: true,
    colorDecorators: true,
  }), [tabSize, insertSpaces, detectIndentation]);

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    if (!themesRegistered) {
      themesRegistered = true;
      monaco.editor.defineTheme('toquemedia-vibrant', toqueMediaTheme);
      monaco.editor.defineTheme('toquemedia-soft', toqueMediaSoftTheme);
    }
  }, []);

  const handleMount = useCallback((ed: editor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = ed;
    dirtyRef.current = false;
    pendingRef.current = null;
    MonacoBridge.getInstance().setCurrentEditor(ed);

    try {
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2020,
        allowNonTsExtensions: true,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        noEmit: true, jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
        esModuleInterop: true, allowSyntheticDefaultImports: true,
      });
      monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
      monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
    } catch {}

    try {
      window.dispatchEvent(new CustomEvent('monaco:languages', {
        detail: monaco.languages.getLanguages().map((l: { id: string }) => l.id),
      }));
    } catch {}

    disposablesRef.current.forEach(d => d.dispose());
    disposablesRef.current = [];

    const boundPath = pathRef.current;

    // Cursor — callback only
    disposablesRef.current.push(
      ed.onDidChangeCursorPosition(e => {
        cursorCbRef.current?.(e.position.lineNumber, e.position.column);
      })
    );

    // Content change — capture to ref + autosave 3s
    disposablesRef.current.push(
      ed.onDidChangeModelContent(() => {
        dirtyRef.current = true;
        // Capture content to ref — survives editor disposal on tab switch
        try { pendingRef.current = { path: boundPath, content: ed.getValue() }; } catch {}

        if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
        autoSaveRef.current = setTimeout(() => {
          autoSaveRef.current = null;
          if (pathRef.current !== boundPath) return;
          const inst = editorRef.current;
          if (!inst) return;
          try {
            pushContentToStore(boundPath, inst.getValue());
          } catch {}
          dirtyRef.current = false;
          pendingRef.current = null;
          useEditorRepository.getState().saveFile(boundPath).catch(e =>
            logger.error('editor', 'Autosave failed', e)
          );
        }, 3000);
      })
    );

    // Cmd+S
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (autoSaveRef.current) { clearTimeout(autoSaveRef.current); autoSaveRef.current = null; }
      try {
        const inst = editorRef.current;
        if (inst) pushContentToStore(pathRef.current, inst.getValue());
      } catch {}
      dirtyRef.current = false;
      pendingRef.current = null;
      useEditorRepository.getState().saveFile(pathRef.current).catch(e =>
        logger.error('editor', 'Save failed', e)
      );
    });

    ed.focus();
  }, []);

  // Cleanup on unmount/path change — uses captured content from pendingRef
  useEffect(() => {
    const effectPath = path;
    return () => {
      if (autoSaveRef.current) { clearTimeout(autoSaveRef.current); autoSaveRef.current = null; }
      disposablesRef.current.forEach(d => d.dispose());
      disposablesRef.current = [];

      // Sync dirty content + save to disk
      if (dirtyRef.current && pendingRef.current && pendingRef.current.path === effectPath) {
        pushContentToStore(effectPath, pendingRef.current.content);
        useEditorRepository.getState().saveFile(effectPath).catch(e =>
          logger.error('editor', 'Save on tab switch failed', e)
        );
      }
      dirtyRef.current = false;
      pendingRef.current = null;

      const bridge = MonacoBridge.getInstance();
      if (editorRef.current && bridge.getCurrentEditor() === editorRef.current) {
        bridge.setCurrentEditor(null);
      }
    };
  }, [path]);

  // Focus on path change
  useEffect(() => { editorRef.current?.focus(); }, [path]);

  // Reveal position (Problems panel)
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { file: string; line: number; column: number } | undefined;
      if (!d || d.file !== pathRef.current || !editorRef.current) return;
      editorRef.current.setPosition({ lineNumber: d.line, column: d.column });
      editorRef.current.revealLineInCenter(d.line);
      editorRef.current.focus();
    };
    window.addEventListener('monaco:revealPosition', handler);
    return () => window.removeEventListener('monaco:revealPosition', handler);
  }, []);

  const store = useEditorRepository.getState();
  const file = store.openFiles.find(f => f.path === path);
  if (!file) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: tokens.colors.text.secondary, fontSize: '14px', flexDirection: 'column', gap: '8px' }}>
        <div>File not found</div>
        <div style={{ fontSize: '12px', opacity: 0.7 }}>{path}</div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <Editor
        height="100%"
        path={path}
        defaultLanguage={file.language}
        language={file.language}
        defaultValue={file.content}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        options={options}
        theme="toquemedia-vibrant"
        loading={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: tokens.colors.text.secondary, fontSize: '14px' }}>
            Loading editor...
          </div>
        }
      />
    </div>
  );
};

export default MonacoEditor;
