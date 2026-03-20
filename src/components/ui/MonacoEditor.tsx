import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import Editor, { Monaco, loader } from '@monaco-editor/react';
import * as monacoEditor from 'monaco-editor';
import type { editor, IDisposable } from 'monaco-editor';

// Use local monaco-editor instead of CDN
loader.config({ monaco: monacoEditor });
import { tokens } from '@/theme/tokens';
import { logger } from '../../utils/logger';
import MonacoBridge from '../../utils/monacoBridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { useEditorRepository } from '../../stores/editorStore';
import { FileService } from '../../services/fileService';
import { GitService, type GitLineChange } from '../../services/gitService';
import { FormatterService } from '../../services/formatterService';
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
let formattingProviderRegistered = false;

// Per-file cursor position cache — survives tab switches without Zustand
const cursorCache = new Map<string, { line: number; col: number }>();

function pushContentToStore(path: string, content: string) {
  try {
    const store = useEditorRepository.getState();
    const file = store.openFiles.find(f => f.path === path);
    if (file && file.content !== content) {
      store.updateFileContent(path, content);
    }
  } catch {}
}

// Register Prettier as a document formatting provider
function registerFormattingProvider(monaco: Monaco) {
  if (formattingProviderRegistered) return;
  formattingProviderRegistered = true;

  const formatter = FormatterService.getInstance();
  const supportedLanguages = ['javascript', 'typescript', 'json', 'html', 'css', 'scss', 'less', 'markdown'];

  for (const langId of supportedLanguages) {
    monaco.languages.registerDocumentFormattingEditProvider(langId, {
      displayName: 'Prettier',
      provideDocumentFormattingEdits: async (model: monacoEditor.editor.ITextModel) => {
        const code = model.getValue();
        const formatted = await formatter.formatCode(code, langId);
        if (formatted === null || formatted === code) return [];

        return [{
          range: model.getFullModelRange(),
          text: formatted,
        }];
      },
    });
  }
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
  const pendingRef = useRef<{ path: string; content: string } | null>(null);
  const gutterDecorationsRef = useRef<string[]>([]);

  cursorCbRef.current = onCursorPositionChange;
  pathRef.current = path;

  const tabSize = useSettingsStore(s => s.editor.tabSize);
  const insertSpaces = useSettingsStore(s => s.editor.insertSpaces);
  const detectIndentation = useSettingsStore(s => s.editor.detectIndentation);

  const options = useMemo((): editor.IStandaloneEditorConstructionOptions => ({
    automaticLayout: true,
    padding: { top: 12, bottom: 12 },
    fixedOverflowWidgets: true,
    fontSize: 13.5,
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", Monaco, Menlo, monospace',
    fontLigatures: true,
    fontWeight: '400',
    lineHeight: 22,
    letterSpacing: 0.3,
    tabSize, insertSpaces, detectIndentation,
    scrollBeyondLastLine: true,
    smoothScrolling: true,
    mouseWheelScrollSensitivity: 1.5,
    fastScrollSensitivity: 5,
    wordWrap: 'on',
    wordWrapColumn: 120,
    wrappingIndent: 'indent',
    minimap: { enabled: true, side: 'right', showSlider: 'mouseover', renderCharacters: false, maxColumn: 80, scale: 1 },
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false, verticalHasArrows: false, horizontalHasArrows: false },
    overviewRulerBorder: false,
    overviewRulerLanes: 2,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    cursorWidth: 2,
    cursorStyle: 'line',
    bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
    guides: { bracketPairs: 'active', bracketPairsHorizontal: 'active', indentation: true, highlightActiveIndentation: true },
    matchBrackets: 'always',
    folding: true,
    foldingHighlight: true,
    foldingStrategy: 'auto',
    showFoldingControls: 'mouseover',
    stickyScroll: { enabled: true, maxLineCount: 3 },
    lineNumbers: 'on',
    lineNumbersMinChars: 4,
    lineDecorationsWidth: 8,
    glyphMargin: true,
    renderLineHighlight: 'all',
    quickSuggestions: { other: 'on', comments: 'off', strings: 'on' },
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnEnter: 'on',
    acceptSuggestionOnCommitCharacter: true,
    snippetSuggestions: 'inline',
    tabCompletion: 'on',
    wordBasedSuggestions: 'currentDocument',
    suggest: { preview: true, filterGraceful: true, showIcons: true },
    parameterHints: { enabled: true, cycle: true },
    linkedEditing: true,
    autoIndent: 'full',
    autoClosingBrackets: 'always',
    autoClosingQuotes: 'always',
    autoSurround: 'languageDefined',
    formatOnPaste: false,
    formatOnType: false,
    renderWhitespace: 'selection',
    renderControlCharacters: true,
    links: true,
    colorDecorators: true,
    codeLens: false,
    contextmenu: true,
    accessibilitySupport: 'auto',
    find: { addExtraSpaceOnTop: false, autoFindInSelection: 'multiline', seedSearchStringFromSelection: 'selection' },
    largeFileOptimizations: true,
    maxTokenizationLineLength: 20000,
    stopRenderingLineAfter: 10000,
    multiCursorModifier: 'alt',
    multiCursorPaste: 'spread',
  }), [tabSize, insertSpaces, detectIndentation]);

  // ── Git Gutter ───────────────────────────────────────────────────────────

  const updateGitGutter = useCallback(async (ed: editor.IStandaloneCodeEditor) => {
    try {
      const changes = await GitService.getDiffLines(pathRef.current);
      const model = ed.getModel();
      if (!model) return;

      const decorations: editor.IModelDeltaDecoration[] = changes.map((change: GitLineChange) => {
        let className: string;
        let glyphClassName: string;
        switch (change.kind) {
          case 'added':
            className = 'git-gutter-added';
            glyphClassName = 'git-glyph-added';
            break;
          case 'modified':
            className = 'git-gutter-modified';
            glyphClassName = 'git-glyph-modified';
            break;
          case 'removed':
            className = 'git-gutter-removed';
            glyphClassName = 'git-glyph-removed';
            break;
          default:
            className = '';
            glyphClassName = '';
        }

        const endLine = Math.min(change.start_line + change.line_count - 1, model.getLineCount());

        return {
          range: new monacoEditor.Range(change.start_line, 1, endLine, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: className,
            glyphMarginClassName: glyphClassName,
            overviewRuler: {
              color: change.kind === 'added' ? tokens.colors.accent.green
                : change.kind === 'modified' ? tokens.colors.accent.blue
                : tokens.colors.accent.red,
              position: monacoEditor.editor.OverviewRulerLane.Left,
            },
          },
        };
      });

      gutterDecorationsRef.current = ed.deltaDecorations(gutterDecorationsRef.current, decorations);
    } catch {
      // Silently fail — git may not be available
    }
  }, []);

  // ── Editor Mount ─────────────────────────────────────────────────────────

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    if (!themesRegistered) {
      themesRegistered = true;
      monaco.editor.defineTheme('toquemedia-vibrant', toqueMediaTheme);
      monaco.editor.defineTheme('toquemedia-soft', toqueMediaSoftTheme);
    }

    // Register Prettier formatting provider
    registerFormattingProvider(monaco);

    // Register LinkProvider for import paths
    for (const langId of ['typescript', 'javascript']) {
      monaco.languages.registerLinkProvider(langId, {
        provideLinks: (model: monacoEditor.editor.ITextModel) => {
          const links: monacoEditor.languages.ILink[] = [];
          const lineCount = Math.min(model.getLineCount(), 2000);
          for (let i = 1; i <= lineCount; i++) {
            const line = model.getLineContent(i);
            const patterns = [
              /from\s+['"](\.[^'"]+)['"]/g,
              /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
              /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
            ];
            for (const pattern of patterns) {
              let m;
              while ((m = pattern.exec(line)) !== null) {
                const pathStr = m[1];
                const pathStart = line.indexOf(pathStr, m.index);
                links.push({
                  range: {
                    startLineNumber: i,
                    startColumn: pathStart + 1,
                    endLineNumber: i,
                    endColumn: pathStart + pathStr.length + 1,
                  },
                  url: monacoEditor.Uri.parse(`file://${pathStr}`),
                });
              }
            }
          }
          return { links };
        },
      });
    }
  }, []);

  const handleMount = useCallback((ed: editor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = ed;
    dirtyRef.current = false;
    pendingRef.current = null;
    gutterDecorationsRef.current = [];
    MonacoBridge.getInstance().setCurrentEditor(ed);

    try {
      const tsDefaults = monaco.languages.typescript.typescriptDefaults;
      const jsDefaults = monaco.languages.typescript.javascriptDefaults;

      tsDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2016,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        jsx: monaco.languages.typescript.JsxEmit.React,
        allowNonTsExtensions: true,
        noEmit: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        skipLibCheck: true,
      });

      jsDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2016,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        jsx: monaco.languages.typescript.JsxEmit.React,
        allowNonTsExtensions: true,
        allowJs: true,
        checkJs: false,
        noEmit: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      });

      tsDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        diagnosticCodesToIgnore: [1108, 2307, 2304, 7016],
      });
      jsDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        diagnosticCodesToIgnore: [1108, 2307, 2304, 7016, 8010],
      });

      tsDefaults.setEagerModelSync(true);
      jsDefaults.setEagerModelSync(true);
    } catch {}

    try {
      window.dispatchEvent(new CustomEvent('monaco:languages', {
        detail: monaco.languages.getLanguages().map((l: { id: string }) => l.id),
      }));
    } catch {}

    disposablesRef.current.forEach(d => d.dispose());
    disposablesRef.current = [];

    const boundPath = pathRef.current;

    // Format document using Prettier
    const doFormat = async (): Promise<boolean> => {
      const inst = editorRef.current;
      if (!inst) return false;
      try {
        const action = inst.getAction('editor.action.formatDocument');
        if (action) {
          await action.run();
          return true;
        }
      } catch {}
      return false;
    };

    // Save handler
    const doSave = async () => {
      if (autoSaveRef.current) { clearTimeout(autoSaveRef.current); autoSaveRef.current = null; }
      const inst = editorRef.current;
      if (!inst) return;

      // Format on save if enabled
      const { formatOnSave } = useSettingsStore.getState();
      if (formatOnSave) {
        await doFormat();
      }

      try {
        const content = inst.getValue();
        pendingRef.current = { path: pathRef.current, content };
        await FileService.writeFile(pathRef.current, content);
      } catch (e) {
        logger.error('editor', 'Save failed', e);
      }
      dirtyRef.current = false;

      // Refresh git gutter after save
      updateGitGutter(inst);
    };

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { doSave(); });
    ed.addAction({ id: 'tmcode.save', label: 'Save', run: () => { doSave(); } });

    // Override Monaco's Go to Line / Quick Outline — their QuickInput widgets freeze in Tauri WebView
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () => {});
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO, () => {});

    // Content change — autosave directly to disk
    disposablesRef.current.push(
      ed.onDidChangeModelContent(() => {
        dirtyRef.current = true;
        if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
        autoSaveRef.current = setTimeout(() => {
          autoSaveRef.current = null;
          if (pathRef.current !== boundPath) return;
          const inst = editorRef.current;
          if (!inst) return;
          try {
            const content = inst.getValue();
            pendingRef.current = { path: boundPath, content };
            FileService.writeFile(boundPath, content).then(() => {
              dirtyRef.current = false;
            }).catch(e =>
              logger.error('editor', 'Autosave failed', e)
            );
          } catch {}
        }, 3000);
      })
    );

    // --- Cmd+Click to follow import paths ---

    function findImportPathRange(lineContent: string, lineNumber: number): { path: string; range: monacoEditor.IRange } | null {
      const patterns = [
        /from\s+['"]([^'"]+)['"]/,
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
        /import\s*\(\s*['"]([^'"]+)['"]\s*\)/,
      ];
      for (const pattern of patterns) {
        const match = lineContent.match(pattern);
        if (match && match[1]) {
          const fullMatch = match[0];
          const pathStr = match[1];
          const matchStart = lineContent.indexOf(fullMatch);
          const pathStart = lineContent.indexOf(pathStr, matchStart);
          return {
            path: pathStr,
            range: {
              startLineNumber: lineNumber,
              startColumn: pathStart + 1,
              endLineNumber: lineNumber,
              endColumn: pathStart + pathStr.length + 1,
            },
          };
        }
      }
      return null;
    }

    function resolveImportPath(importPath: string): string {
      if (!importPath.startsWith('.')) return importPath;
      const currentDir = boundPath.substring(0, boundPath.lastIndexOf('/'));
      const parts = (currentDir + '/' + importPath).split('/');
      const normalized: string[] = [];
      for (const p of parts) {
        if (p === '..') normalized.pop();
        else if (p !== '.') normalized.push(p);
      }
      return normalized.join('/');
    }

    disposablesRef.current.push(
      ed.onMouseDown((e) => {
        if (!e.event.metaKey && !e.event.ctrlKey) return;
        if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;

        const model = ed.getModel();
        if (!model || !e.target.position) return;

        const line = model.getLineContent(e.target.position.lineNumber);
        const found = findImportPathRange(line, e.target.position.lineNumber);

        if (!found || !found.path.startsWith('.')) return;

        if (e.target.position.column < found.range.startColumn ||
            e.target.position.column > found.range.endColumn) return;

        const resolved = resolveImportPath(found.path);
        const extensions = ['', '.tsx', '.ts', '.jsx', '.js', '.css', '.scss', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

        (async () => {
          for (const ext of extensions) {
            try {
              await FileService.readFile(resolved + ext);
              useEditorRepository.getState().openFile(resolved + ext);
              return;
            } catch {}
          }
        })();
      })
    );

    // Register keyboard shortcuts for built-in Monaco actions
    ed.addAction({
      id: 'tmcode.gotoLine',
      label: 'Go to Line...',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG],
      run: (editor) => { editor.trigger('keyboard', 'editor.action.gotoLine', null); },
    });

    ed.addAction({
      id: 'tmcode.quickOutline',
      label: 'Go to Symbol...',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO],
      run: (editor) => { editor.trigger('keyboard', 'editor.action.quickOutline', null); },
    });

    // Restore cursor position from local cache (no Zustand)
    const cached = cursorCache.get(boundPath);
    if (cached) {
      setTimeout(() => {
        const inst = editorRef.current;
        if (!inst) return;
        inst.setPosition({ lineNumber: cached.line, column: cached.col });
        inst.revealLineInCenter(cached.line);
        inst.focus();
      }, 50);
    } else {
      ed.focus();
    }

    // Load git gutter decorations
    updateGitGutter(ed);
  }, [updateGitGutter]);

  // Cleanup — save cursor + content before tab switch
  useEffect(() => {
    const effectPath = path;
    return () => {
      try {
        const inst = editorRef.current;
        if (inst) {
          const pos = inst.getPosition();
          if (pos) {
            cursorCache.set(effectPath, { line: pos.lineNumber, col: pos.column });
          }
        }
      } catch {}

      if (autoSaveRef.current) { clearTimeout(autoSaveRef.current); autoSaveRef.current = null; }
      disposablesRef.current.forEach(d => d.dispose());
      disposablesRef.current = [];
      if (dirtyRef.current) {
        let content: string | null = null;
        try { content = editorRef.current?.getValue() ?? null; } catch {}
        if (!content && pendingRef.current?.path === effectPath) {
          content = pendingRef.current.content;
        }
        if (content) {
          FileService.writeFile(effectPath, content).catch(e =>
            logger.error('editor', 'Save on tab switch failed', e)
          );
          pushContentToStore(effectPath, content);
        }
      }
      dirtyRef.current = false;
      pendingRef.current = null;
      const bridge = MonacoBridge.getInstance();
      if (editorRef.current && bridge.getCurrentEditor() === editorRef.current) {
        bridge.setCurrentEditor(null);
      }
    };
  }, [path]);

  // Focus editor when path changes
  useEffect(() => { editorRef.current?.focus(); }, [path]);

  // Reveal position
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

  // Claim bridge — when this pane is focused in split mode, re-register with MonacoBridge
  useEffect(() => {
    const handler = (e: Event) => {
      const targetPath = (e as CustomEvent<string>).detail;
      if (targetPath === pathRef.current && editorRef.current) {
        MonacoBridge.getInstance().setCurrentEditor(editorRef.current);
      }
    };
    window.addEventListener('monaco:claimBridge', handler);
    return () => window.removeEventListener('monaco:claimBridge', handler);
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
