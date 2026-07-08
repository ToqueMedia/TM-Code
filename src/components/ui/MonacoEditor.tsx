import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import Editor, { Monaco, loader } from '@monaco-editor/react';
import * as monacoEditor from 'monaco-editor';
import type { editor, IDisposable } from 'monaco-editor';
import { Box } from '@chakra-ui/react';

// Use local monaco-editor instead of CDN
loader.config({ monaco: monacoEditor });
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n';
import { logger } from '../../utils/logger';
import MonacoBridge from '../../utils/monacoBridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { useEditorRepository } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';
import { FileService } from '../../services/fileService';
import { GitService, type GitLineChange } from '../../services/gitService';
import { FormatterService } from '../../services/formatterService';
import AICompletionService from '../../services/aiCompletionService';
import { registerReactTypeLibraries } from '../../services/monacoTypeLibraries';
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

// Formatting provider registered once globally
let formattingProviderRegistered = false;
// Link providers + formatters registered once globally (not per file mount)
let monacoProvidersRegistered = false;
// TS/JS compiler config set once globally
let tsConfigRegistered = false;

// Per-file cursor position cache — survives tab switches without Zustand
// Uses composite key "groupId::path" to isolate split panes
const cursorCache = new Map<string, { line: number; col: number }>();

const MAX_CURSOR_CACHE = 200;
function setCursorCached(key: string, pos: { line: number; col: number }) {
  cursorCache.set(key, pos);
  if (cursorCache.size > MAX_CURSOR_CACHE) {
    // Map iteration order is insertion order — delete oldest entries
    const iter = cursorCache.keys();
    while (cursorCache.size > MAX_CURSOR_CACHE) {
      const oldest = iter.next().value;
      if (oldest) cursorCache.delete(oldest);
    }
  }
}

function pushContentToStore(path: string, content: string) {
  try {
    const store = useEditorRepository.getState();
    const file = store.openFiles.find(f => f.path === path);
    if (file && file.content !== content) {
      store.updateFileContent(path, content);
    }
  } catch {}
}

// Model → file path it was created for. Edits/saves are attributed to the
// path bound to the MODEL, never to the component's `path` prop: during the
// async gap of a tab switch (file not yet read from disk) the editor still
// shows the previous model, and attributing those keystrokes to the new path
// would silently corrupt the other file in the store.
const modelPaths = new WeakMap<editor.ITextModel, string>();

function acquireModel(path: string, content: string, language: string): editor.ITextModel {
  const uri = monacoEditor.Uri.file(path);
  let model = monacoEditor.editor.getModel(uri);
  if (!model) {
    model = monacoEditor.editor.createModel(content, language, uri);
  }
  modelPaths.set(model, path);
  return model;
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

const MIRRORED_PAIR_CHARS: Record<string, string> = {
  '"': '"',
  "'": "'",
  '`': '`',
  '(': ')',
  '[': ']',
  '{': '}',
}

function isPunctuationOnlyCompletion(text: string): boolean {
  return /^[\s"'`()[\]{}<>.,;:!?]+$/.test(text)
}

function shouldSuppressInlineCompletion(prefix: string, suffix: string, suggestion: string): boolean {
  const trimmed = suggestion.trim()
  if (!trimmed) return true

  const previous = prefix.slice(-1)
  const next = suffix.charAt(0)
  if (previous && MIRRORED_PAIR_CHARS[previous] === next) return true

  if (isPunctuationOnlyCompletion(trimmed)) return true

  const nextNonWhitespace = suffix.trimStart()
  if (nextNonWhitespace && nextNonWhitespace.startsWith(trimmed)) return true

  return false
}

interface MonacoEditorProps {
  path: string;
  groupId?: string;
  onCursorPositionChange?: (line: number, column: number) => void;
}

const MonacoEditor: React.FC<MonacoEditorProps> = ({ path, groupId = 'main', onCursorPositionChange }) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const pathRef = useRef(path);
  const prevPathRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);
  const cursorCbRef = useRef(onCursorPositionChange);
  const pendingRef = useRef<{ path: string; content: string } | null>(null);
  const gutterCollectionRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const applyingStoreUpdateRef = useRef(false);

  cursorCbRef.current = onCursorPositionChange;
  pathRef.current = path;

  const tabSize = useSettingsStore(s => s.editor.tabSize);
  const insertSpaces = useSettingsStore(s => s.editor.insertSpaces);
  const detectIndentation = useSettingsStore(s => s.editor.detectIndentation);

  // Reactive lookup — the previous getState() read never re-rendered this
  // component on its own; it only worked because parents happened to
  // re-render on every store change. The selector returns the same object
  // reference while the entry is untouched, so re-renders stay scoped.
  const file = useEditorRepository(s => s.openFiles.find(f => f.path === path));
  const hasFile = !!file;

  const options = useMemo((): editor.IStandaloneEditorConstructionOptions => ({
    automaticLayout: true,
    padding: { top: 18, bottom: 24 },
    fixedOverflowWidgets: true,
    fontSize: 14,
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", Monaco, Menlo, monospace',
    fontLigatures: true,
    fontWeight: '400',
    lineHeight: 23,
    letterSpacing: 0,
    tabSize, insertSpaces, detectIndentation,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    mouseWheelScrollSensitivity: 1.5,
    fastScrollSensitivity: 5,
    wordWrap: 'on',
    wordWrapColumn: 120,
    wrappingIndent: 'indent',
    minimap: { enabled: true, side: 'right', showSlider: 'mouseover', renderCharacters: false, maxColumn: 80, scale: 0.9 },
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
    stickyScroll: { enabled: true, maxLineCount: 4 },
    lineNumbers: 'on',
    lineNumbersMinChars: 4,
    lineDecorationsWidth: 8,
    glyphMargin: true,
    renderLineHighlight: 'line',
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
    renderWhitespace: 'boundary',
    renderControlCharacters: true,
    links: true,
    colorDecorators: true,
    codeLens: false,
    // Monaco's built-in context menu — cut/copy/paste, Go to Definition,
    // Find References, Format Document, etc. Disabling it was a leftover
    // from a phase where we mounted a custom overlay; the overlay never
    // shipped, so users were left with no right-click affordance in the
    // editor. Re-enable.
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
      if (changes.length === 0) {
        // Clear decorations if no changes
        if (gutterCollectionRef.current) gutterCollectionRef.current.set([]);
        return;
      }

      const decorations: editor.IModelDeltaDecoration[] = changes.map((change: GitLineChange) => {
        let className: string;
        switch (change.kind) {
          case 'added': className = 'git-gutter-added'; break;
          case 'modified': className = 'git-gutter-modified'; break;
          case 'removed': className = 'git-gutter-removed'; break;
          default: className = '';
        }

        const endLine = Math.min(change.start_line + change.line_count - 1, model.getLineCount());

        return {
          range: new monacoEditor.Range(change.start_line, 1, endLine, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: className,
            overviewRuler: {
              color: change.kind === 'added' ? tokens.colors.accent.green
                : change.kind === 'modified' ? tokens.colors.accent.blue
                : tokens.colors.accent.red,
              position: monacoEditor.editor.OverviewRulerLane.Left,
            },
          },
        };
      });

      // Inject CSS rule dynamically (ensures it exists in the document)
      if (!document.getElementById('git-gutter-styles')) {
        const style = document.createElement('style');
        style.id = 'git-gutter-styles';
        style.textContent = `
          .cldr.git-gutter-added { border-left: 3px solid #2ea043 !important; }
          .cldr.git-gutter-modified { border-left: 3px solid #007acc !important; }
          .cldr.git-gutter-removed { border-left: 3px solid #f85149 !important; }
        `;
        document.head.appendChild(style);
      }

      // Use createDecorationsCollection (Monaco 0.55+)
      if (gutterCollectionRef.current) {
        gutterCollectionRef.current.set(decorations);
      } else {
        gutterCollectionRef.current = ed.createDecorationsCollection(decorations);
      }
    } catch (err) {
      logger.debug('editor', 'Git gutter update failed:', err);
    }
  }, []);

  // ── Saving ───────────────────────────────────────────────────────────────

  // Single write path shared by Cmd+S, auto-save, blur-save, tab-switch and
  // unmount. Clears the dirty flag only if the model version is unchanged
  // after the async write — edits typed while the write was in flight keep
  // the buffer dirty (VS Code's guard against silently "clean" stale saves).
  const saveModel = useCallback(async (
    model: editor.ITextModel,
    savePath: string,
    opts?: { format?: boolean }
  ) => {
    if (autoSaveRef.current) { clearTimeout(autoSaveRef.current); autoSaveRef.current = null; }
    if (contentSyncRef.current) { clearTimeout(contentSyncRef.current); contentSyncRef.current = null; }

    // Format only on explicit saves (VS Code never formats on auto-save),
    // and only if this model is the one currently in the editor.
    if (opts?.format && editorRef.current && editorRef.current.getModel() === model) {
      try { await editorRef.current.getAction('editor.action.formatDocument')?.run(); } catch {}
    }

    if (model.isDisposed()) return;
    const saveVersion = model.getAlternativeVersionId();
    const content = model.getValue();
    pendingRef.current = { path: savePath, content };
    pushContentToStore(savePath, content);

    try {
      await FileService.writeFile(savePath, content);
      const unchangedSinceWrite = !model.isDisposed() && model.getAlternativeVersionId() === saveVersion;
      if (unchangedSinceWrite) {
        if (pathRef.current === savePath) dirtyRef.current = false;
        pendingRef.current = null;
        useEditorRepository.getState().markFileSaved(savePath, content);
      }
    } catch (e) {
      logger.error('editor', 'Save failed', e);
      pendingRef.current = null;
    }

    if (editorRef.current && pathRef.current === savePath) {
      updateGitGutter(editorRef.current);
    }
  }, [updateGitGutter]);

  // ── Editor Mount ─────────────────────────────────────────────────────────

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    // Themes must be (re)defined each mount for theme switching
    monaco.editor.defineTheme('toquemedia-vibrant', toqueMediaTheme);
    monaco.editor.defineTheme('toquemedia-soft', toqueMediaSoftTheme);

    // One-time global registrations (providers, formatters, link providers)
    if (!monacoProvidersRegistered) {
      monacoProvidersRegistered = true;

      registerFormattingProvider(monaco);

      for (const langId of ['typescript', 'javascript']) {
        monaco.languages.registerLinkProvider(langId, {
          provideLinks: (model: monacoEditor.editor.ITextModel) => {
            const links: monacoEditor.languages.ILink[] = [];
            // Cap the scan — this runs on every content change, and regexing
            // hundreds of thousands of lines would stall the UI thread.
            const lineCount = Math.min(model.getLineCount(), 5000);
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
    }
  }, []);

  const handleMount = useCallback((ed: editor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = ed;
    dirtyRef.current = false;
    pendingRef.current = null;
    gutterCollectionRef.current = null;
    MonacoBridge.getInstance().setCurrentEditor(ed);

    // TS/JS compiler config — set once, not per file mount
    if (!tsConfigRegistered) {
      tsConfigRegistered = true;
      try {
        const tsDefaults = monaco.languages.typescript.typescriptDefaults;
        const jsDefaults = monaco.languages.typescript.javascriptDefaults;

        tsDefaults.setCompilerOptions({
          target: monaco.languages.typescript.ScriptTarget.ES2016,
          module: monaco.languages.typescript.ModuleKind.ESNext,
          moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
          jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
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
          jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
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

        registerReactTypeLibraries(monaco);

        tsDefaults.setEagerModelSync(true);
        jsDefaults.setEagerModelSync(true);
      } catch {}
    }

    try {
      window.dispatchEvent(new CustomEvent('monaco:languages', {
        detail: monaco.languages.getLanguages().map((l: { id: string }) => l.id),
      }));
    } catch {}

    disposablesRef.current.forEach(d => d.dispose());
    disposablesRef.current = [];

    // Register AI inline completion provider (Ollama FIM)
    const inlineProvider = monaco.languages.registerInlineCompletionsProvider(
      { pattern: '**' }, // all languages
      {
        provideInlineCompletions: async (model: monacoEditor.editor.ITextModel, position: monacoEditor.Position, _context: monacoEditor.languages.InlineCompletionContext, token: monacoEditor.CancellationToken) => {
          if (token.isCancellationRequested) return { items: [] };

          const textUntilPosition = model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });
          const textAfterPosition = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: model.getLineCount(),
            endColumn: model.getLineMaxColumn(model.getLineCount()),
          });

          // Limit context to ~2K chars each side
          const prefix = textUntilPosition.slice(-2000);
          const suffix = textAfterPosition.slice(0, 1000);

          const result = await AICompletionService.getInstance().getCompletion(prefix, suffix);
          if (!result || token.isCancellationRequested) return { items: [] };
          if (shouldSuppressInlineCompletion(prefix, suffix, result)) return { items: [] };

          return {
            items: [{
              insertText: result,
              range: {
                startLineNumber: position.lineNumber,
                startColumn: position.column,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              },
            }],
          };
        },
        freeInlineCompletions() {},
        // Monaco 0.55+ calls disposeInlineCompletions when clearing suggestions
        disposeInlineCompletions() {},
      }
    );
    disposablesRef.current.push(inlineProvider);

    const boundPath = pathRef.current;

    // Explicit save (Cmd+S / menu) — formats when formatOnSave is enabled
    const doSave = async () => {
      const inst = editorRef.current;
      if (!inst) {
        console.warn('[MonacoEditor:doSave] No editor instance');
        return;
      }
      const model = inst.getModel();
      if (!model) return;
      const savePath = modelPaths.get(model) ?? pathRef.current;
      const { formatOnSave } = useSettingsStore.getState();
      await saveModel(model, savePath, { format: formatOnSave });
    };

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { doSave(); });
    ed.addAction({ id: 'tmcode.save', label: 'Save', run: () => { doSave(); } });

    // Override Monaco's Go to Line / Quick Outline — their QuickInput widgets freeze in Tauri WebView
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () => {});
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO, () => {});

    disposablesRef.current.push(ed.onKeyDown((event) => {
      const cancelsInlineCompletion =
        event.keyCode === monaco.KeyCode.Backspace ||
        event.keyCode === monaco.KeyCode.Delete ||
        event.keyCode === monaco.KeyCode.LeftArrow ||
        event.keyCode === monaco.KeyCode.RightArrow ||
        event.keyCode === monaco.KeyCode.UpArrow ||
        event.keyCode === monaco.KeyCode.DownArrow ||
        event.keyCode === monaco.KeyCode.Home ||
        event.keyCode === monaco.KeyCode.End ||
        event.keyCode === monaco.KeyCode.Escape

      if (cancelsInlineCompletion) {
        AICompletionService.getInstance().cancel()
      }
    }));

    // Content change — three responsibilities, each on its own budget:
    //  1. Immediately flip the dirty flag in the store (one cheap update →
    //     tab dot appears on the first keystroke).
    //  2. Debounce the full-content sync to the store. Pushing getValue()
    //     per keystroke copied the whole file (plus an undo-stack snapshot)
    //     on every key and re-rendered the entire editor chrome; 300ms
    //     coalesces a typing burst into one push. Save/tab-switch/unmount
    //     all flush fresh content explicitly, so nothing user-visible lags.
    //  3. Schedule auto-save per the user's setting (VS Code 'afterDelay':
    //     debounced from the LAST edit; never formats).
    disposablesRef.current.push(
      ed.onDidChangeModelContent(() => {
        if (applyingStoreUpdateRef.current) return;
        dirtyRef.current = true;
        const model = ed.getModel();
        if (!model) return;
        // Attribute to the model's bound path — during a tab-switch gap the
        // prop path may already point at a file whose model isn't ready yet.
        const boundPath = modelPaths.get(model) ?? pathRef.current;
        if (!boundPath) return;

        useEditorRepository.getState().markFileDirty(boundPath);

        if (contentSyncRef.current) clearTimeout(contentSyncRef.current);
        contentSyncRef.current = setTimeout(() => {
          contentSyncRef.current = null;
          try {
            if (model.isDisposed()) return;
            const content = model.getValue();
            pendingRef.current = { path: boundPath, content };
            pushContentToStore(boundPath, content);
          } catch {}
        }, 300);

        if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
        autoSaveRef.current = null;
        const { autoSave, autoSaveDelay } = useSettingsStore.getState();
        if (autoSave === 'afterDelay') {
          autoSaveRef.current = setTimeout(() => {
            autoSaveRef.current = null;
            if (!model.isDisposed()) void saveModel(model, boundPath);
          }, autoSaveDelay);
        }
      })
    );

    // Auto-save on focus loss (editor blur). Applies to both auto-save
    // modes: in 'afterDelay' it just flushes the pending timer early.
    disposablesRef.current.push(
      ed.onDidBlurEditorWidget(() => {
        const { autoSave } = useSettingsStore.getState();
        if (autoSave === 'off') return;
        const model = ed.getModel();
        if (!model) return;
        const boundPath = modelPaths.get(model) ?? pathRef.current;
        if (!boundPath) return;
        const f = useEditorRepository.getState().openFiles.find(ff => ff.path === boundPath);
        if (f?.isDirty) void saveModel(model, boundPath);
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

    // The editor instance can be disposed without this component unmounting
    // (switching to the image/diff branch unmounts only <Editor>). Null the
    // ref so effects never operate on a disposed instance.
    disposablesRef.current.push(ed.onDidDispose(() => {
      if (editorRef.current === ed) editorRef.current = null;
    }));

    // Initial model setup — create model for the initial file
    // Dispose the empty placeholder model created by @monaco-editor/react
    const placeholderModel = ed.getModel();
    const initialFile = useEditorRepository.getState().openFiles.find(f => f.path === boundPath);
    if (initialFile) {
      const model = acquireModel(boundPath, initialFile.content, initialFile.language);
      if (!initialFile.isDirty && model.getValue() !== initialFile.content) {
        applyingStoreUpdateRef.current = true;
        try {
          model.setValue(initialFile.content);
        } finally {
          applyingStoreUpdateRef.current = false;
        }
      } else if (initialFile.isDirty && model.getValue() !== initialFile.content) {
        pushContentToStore(boundPath, model.getValue());
      }
      ed.setModel(model);
    }
    if (placeholderModel && placeholderModel !== ed.getModel()) {
      placeholderModel.dispose();
    }

    // Restore cursor position
    const cached = cursorCache.get(`${groupId}::${boundPath}`);
    if (cached) {
      ed.setPosition({ lineNumber: cached.line, column: cached.col });
      ed.revealLineInCenter(cached.line);
    }
    ed.focus();
    // Only commit prevPath when the file's model is actually in the editor.
    // If the file is still being read from disk, leaving prevPath as null
    // lets the model-swap effect finish the job when the content arrives.
    prevPathRef.current = initialFile ? boundPath : null;

    // Load git gutter decorations
    updateGitGutter(ed);

    // Custom context menu — dispatch event for EditorContextMenu React component
    const domNode = ed.getDomNode();
    if (domNode) {
      const onCtx = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('editor:contextmenu', {
          detail: { x: e.clientX, y: e.clientY }
        }));
      };
      domNode.addEventListener('contextmenu', onCtx);
      disposablesRef.current.push({ dispose: () => domNode.removeEventListener('contextmenu', onCtx) });
    }

    // Pre-load Prettier project config from project root
    const projectRoot = useProjectStore.getState().currentProject?.path;
    if (projectRoot) {
      FormatterService.getInstance().loadProjectConfig(projectRoot).catch(() => {});
    }
  }, [updateGitGutter, saveModel, groupId]);

  // ── Model swap on tab switch (VS Code-style) ────────────────────────

  useEffect(() => {
    const inst = editorRef.current;
    if (!inst) return;

    const prevPath = prevPathRef.current;

    // Same file — nothing to do
    if (prevPath === path) return;

    // File content not loaded yet (openFile is still reading from disk).
    // Do NOT commit prevPath: leaving it untouched makes this effect run
    // again when `hasFile` flips, completing the deferred swap. Committing
    // early was the old bug — the swap never retried and keystrokes kept
    // flowing into the previous file's model under the new path.
    const nextFile = useEditorRepository.getState().openFiles.find(f => f.path === path);
    if (!nextFile) return;

    prevPathRef.current = path;

    // Flush the previous file: cursor, pending content sync, and — with
    // auto-save on — the file itself (VS Code saves dirty buffers when the
    // user switches away in onFocusChange mode; afterDelay flushes early).
    if (contentSyncRef.current) { clearTimeout(contentSyncRef.current); contentSyncRef.current = null; }
    if (autoSaveRef.current) { clearTimeout(autoSaveRef.current); autoSaveRef.current = null; }
    if (prevPath) {
      try {
        const pos = inst.getPosition();
        if (pos) setCursorCached(`${groupId}::${prevPath}`, { line: pos.lineNumber, col: pos.column });
      } catch {}
      try {
        const prevModel = inst.getModel();
        if (prevModel && modelPaths.get(prevModel) === prevPath) {
          pushContentToStore(prevPath, prevModel.getValue());
          const { autoSave } = useSettingsStore.getState();
          const prevFile = useEditorRepository.getState().openFiles.find(f => f.path === prevPath);
          if (autoSave !== 'off' && prevFile?.isDirty) {
            void saveModel(prevModel, prevPath);
          }
        }
      } catch {}
    }

    const model = acquireModel(path, nextFile.content, nextFile.language);
    if (!nextFile.isDirty && model.getValue() !== nextFile.content) {
      applyingStoreUpdateRef.current = true;
      try {
        model.setValue(nextFile.content);
      } finally {
        applyingStoreUpdateRef.current = false;
      }
    } else if (nextFile.isDirty && model.getValue() !== nextFile.content) {
      pushContentToStore(path, model.getValue());
    }

    // Swap model (near-instant — no parsing, no re-tokenizing if cached)
    const outgoingModel = inst.getModel();
    inst.setModel(model);
    // A leftover placeholder model (inmemory://) from mounting before the
    // file was loaded is unreachable after the swap — dispose it.
    if (outgoingModel && outgoingModel !== model && outgoingModel.uri.scheme !== 'file') {
      outgoingModel.dispose();
    }

    // Restore cursor
    const cached = cursorCache.get(`${groupId}::${path}`);
    if (cached) {
      inst.setPosition({ lineNumber: cached.line, column: cached.col });
      inst.revealLineInCenter(cached.line);
    }

    inst.focus();

    // Update git gutter for the new file
    updateGitGutter(inst);
  }, [path, groupId, hasFile, saveModel, updateGitGutter]);

  // Cleanup on unmount — save everything
  useEffect(() => {
    return () => {
      const inst = editorRef.current;
      const currentPath = pathRef.current;

      // Save cursor
      if (inst && currentPath) {
        try {
          const pos = inst.getPosition();
          if (pos) setCursorCached(`${groupId}::${currentPath}`, { line: pos.lineNumber, col: pos.column });
        } catch {}
      }

      // Flush pending timers
      if (autoSaveRef.current) { clearTimeout(autoSaveRef.current); autoSaveRef.current = null; }
      if (contentSyncRef.current) { clearTimeout(contentSyncRef.current); contentSyncRef.current = null; }
      disposablesRef.current.forEach(d => d.dispose());
      disposablesRef.current = [];

      // Preserve the latest buffer in the store, and — when auto-save is
      // enabled — flush the dirty buffer to disk (fire-and-forget; the
      // dirty flag is only cleared if the write succeeds and content in
      // the store still matches).
      if (inst && currentPath) {
        let content: string | null = null;
        try { content = inst.getValue() ?? null; } catch {}
        if (content === null && pendingRef.current?.path === currentPath) content = pendingRef.current.content;
        if (content !== null) {
          pushContentToStore(currentPath, content);
          const { autoSave } = useSettingsStore.getState();
          const f = useEditorRepository.getState().openFiles.find(ff => ff.path === currentPath);
          if (autoSave !== 'off' && f?.isDirty) {
            const flushed = content;
            FileService.writeFile(currentPath, flushed)
              .then(() => useEditorRepository.getState().markFileSaved(currentPath, flushed))
              .catch(() => {});
          }
        }
      }

      // Dispose model if file is no longer open in any group
      try {
        const { openFiles } = useEditorRepository.getState();
        if (currentPath && !openFiles.some(f => f.path === currentPath)) {
          const uri = monacoEditor.Uri.file(currentPath);
          const model = monacoEditor.editor.getModel(uri);
          model?.dispose();
        }
      } catch {}

      dirtyRef.current = false;
      pendingRef.current = null;
      const bridge = MonacoBridge.getInstance();
      if (inst && bridge.getCurrentEditor() === inst) bridge.setCurrentEditor(null);
    };
  }, []);

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

  // Clear cursor cache + dispose model when file is closed
  useEffect(() => {
    const onTabClosed = (e: Event) => {
      const closedPath = (e as CustomEvent<{ path: string }>).detail?.path;
      if (!closedPath) return;
      for (const key of Array.from(cursorCache.keys())) {
        if (key.endsWith(`::${closedPath}`)) cursorCache.delete(key);
      }
      // Dispose cached model to free memory (only if not currently active)
      if (closedPath !== pathRef.current) {
        const uri = monacoEditor.Uri.file(closedPath);
        const model = monacoEditor.editor.getModel(uri);
        if (model) model.dispose();
      }
    };
    const onClearCursorCache = (e: Event) => {
      const closedPath = (e as CustomEvent<string>).detail;
      if (!closedPath) return;
      for (const key of Array.from(cursorCache.keys())) {
        if (key.endsWith(`::${closedPath}`)) cursorCache.delete(key);
      }
    };
    window.addEventListener('tab:closed', onTabClosed);
    window.addEventListener('editor:clearCursorCache', onClearCursorCache);
    return () => {
      window.removeEventListener('tab:closed', onTabClosed);
      window.removeEventListener('editor:clearCursorCache', onClearCursorCache);
    };
  }, []);

  // Sync model when file content is updated externally (agent, store, disk watcher)
  useEffect(() => {
    const unsubscribe = useEditorRepository.subscribe((state, prevState) => {
      const currentPath = pathRef.current;
      if (!currentPath || !editorRef.current) return;
      const file = state.openFiles.find(f => f.path === currentPath);
      const prevFile = prevState.openFiles.find(f => f.path === currentPath);
      if (!file || !prevFile) return;
      // Only sync if content changed in store and differs from model.
      // Dirty buffers are owned by the editor model and must not be replaced
      // by watcher/agent/store refreshes; this mirrors VS Code's data-loss
      // guard around resolving dirty text models.
      if (file.content !== prevFile.content) {
        const model = editorRef.current.getModel();
        // The model in the editor MUST be the one bound to this path — during
        // a tab-switch gap it can still be the previous file's model, and
        // setValue here would overwrite the wrong file's buffer.
        if (model && modelPaths.get(model) !== currentPath) return;
        if (model && model.getValue() !== file.content) {
          if (file.isDirty) return;
          // Preserve cursor position across the update
          const pos = editorRef.current.getPosition();
          applyingStoreUpdateRef.current = true;
          try {
            model.setValue(file.content);
          } finally {
            applyingStoreUpdateRef.current = false;
          }
          if (pos) {
            const line = Math.min(pos.lineNumber, model.getLineCount());
            const column = Math.min(pos.column, model.getLineMaxColumn(line));
            editorRef.current.setPosition({ lineNumber: line, column });
          }
        }
      }
    });
    return unsubscribe;
  }, []);

  // Refresh git gutter when file is saved externally (e.g. by store, AI agent, or source control)
  useEffect(() => {
    const handler = (e: Event) => {
      const savedPath = (e as CustomEvent<string>).detail;
      // Refresh if path matches OR if no specific path (refresh all)
      if ((!savedPath || savedPath === pathRef.current) && editorRef.current) {
        updateGitGutter(editorRef.current);
      }
    };
    window.addEventListener('git:refreshGutter', handler);
    return () => window.removeEventListener('git:refreshGutter', handler);
  }, [updateGitGutter]);

  // Auto-save when the app window loses focus (VS Code 'onWindowChange'
  // semantics, folded into both auto-save modes as a safety flush).
  useEffect(() => {
    const onWindowBlur = () => {
      const { autoSave } = useSettingsStore.getState();
      if (autoSave === 'off') return;
      const inst = editorRef.current;
      const model = inst?.getModel();
      if (!model) return;
      const boundPath = modelPaths.get(model) ?? pathRef.current;
      if (!boundPath) return;
      const f = useEditorRepository.getState().openFiles.find(ff => ff.path === boundPath);
      if (f?.isDirty) void saveModel(model, boundPath);
    };
    window.addEventListener('blur', onWindowBlur);
    return () => window.removeEventListener('blur', onWindowBlur);
  }, [saveModel]);

  // SVG toggle state — MUST be before any early returns (rules of hooks)
  const [svgViewMode, setSvgViewMode] = useState<'image' | 'code'>('image')

  // Reset view mode when file changes
  const isSvgFile = file?.isImage && file.mimeType === 'image/svg+xml'
  useEffect(() => {
    if (!isSvgFile) {
      setSvgViewMode('image')
    }
  }, [path, isSvgFile])

  // While `openFile` is still reading the file from disk, `file` is missing
  // from the store for a few frames. The old code early-returned a
  // "file not found" placeholder here, which UNMOUNTED the whole Monaco
  // instance and remounted it when the content arrived — the flash the
  // users saw on every first open. Instead we keep <Editor> mounted and
  // draw an opaque overlay; the model-swap effect completes the switch as
  // soon as the content lands. If nothing arrives (the open genuinely
  // failed), the overlay degrades to the not-found message.
  const [openTimedOut, setOpenTimedOut] = useState(false)
  useEffect(() => {
    setOpenTimedOut(false)
    if (hasFile) return
    const timer = setTimeout(() => setOpenTimedOut(true), 5000)
    return () => clearTimeout(timer)
  }, [path, hasFile])

  // Diff mode — render side-by-side diff editor
  if (file?.diff) {
    return (
      <React.Suspense fallback={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: tokens.colors.text.secondary, fontSize: '14px' }}>
          Loading diff...
        </div>
      }>
        <MonacoDiffEditorLazy
          originalContent={file.diff.originalContent}
          modifiedContent={file.content}
          language={file.language}
          originalPath={`HEAD: ${file.diff.relPath}`}
          modifiedPath={file.diff.relPath}
        />
      </React.Suspense>
    );
  }

  // Image preview — render full-size image centered
  if (file?.isImage && file.mimeType && file.base64) {
    const isSvg = file.mimeType === 'image/svg+xml'

    return (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* SVG toggle — top-right corner */}
        {isSvg && (
          <Box
            position="absolute"
            top={8}
            right={12}
            zIndex={20}
            display="flex"
            borderRadius={tokens.radius.md}
            overflow="hidden"
            border={`1px solid ${tokens.colors.border.subtle}`}
            bg={tokens.colors.bg.overlay}
            backdropFilter="blur(8px)"
          >
            {(['image', 'code'] as const).map(mode => (
              <Box
                key={mode}
                as="button"
                px={3}
                py={1.5}
                fontSize="11px"
                fontWeight="500"
                cursor="pointer"
                bg={svgViewMode === mode ? tokens.colors.accent.primarySubtle : 'transparent'}
                color={svgViewMode === mode ? tokens.colors.accent.primary : tokens.colors.text.muted}
                border="none"
                transition={tokens.transition.fast}
                _hover={{
                  bg: svgViewMode === mode ? tokens.colors.accent.primaryHover : tokens.colors.bg.hoverSubtle,
                  color: tokens.colors.text.primary,
                }}
                onClick={() => setSvgViewMode(mode)}
              >
                {mode === 'image' ? t('explorer.image') : t('explorer.code')}
              </Box>
            ))}
          </Box>
        )}

        {isSvg && svgViewMode === 'code' ? (
          /* SVG source code view */
          <div style={{ height: '100%', width: '100%' }}>
            <Editor
              height="100%"
              defaultLanguage="xml"
              defaultValue={file.content}
              beforeMount={handleBeforeMount}
              onMount={handleMount}
              options={options}
              theme="toquemedia-vibrant"
              loading={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: tokens.colors.text.secondary, fontSize: '14px' }}>
                  {t("explorer.loadingEditor")}
                </div>
              }
            />
          </div>
        ) : (
          /* Image preview (all formats) */
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'auto',
              background: `repeating-conic-gradient(#1a1a1a 0% 25%, #141414 0% 50%) 50% / 20px 20px`,
            }}
          >
            <img
              src={`data:${file.mimeType};base64,${file.base64}`}
              alt={path.split('/').pop()}
              style={{
                maxWidth: 'calc(100% - 40px)',
                maxHeight: 'calc(100% - 40px)',
                objectFit: 'contain',
                borderRadius: '4px',
                boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
              }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative' }}>
      <Editor
        height="100%"
        defaultLanguage="typescript"
        defaultValue=""
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        options={options}
        theme="toquemedia-vibrant"
        loading={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: tokens.colors.text.secondary, fontSize: '14px' }}>
            {t("explorer.loadingEditor")}
          </div>
        }
      />
      {!file && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            background: tokens.colors.bg.panel,
            color: tokens.colors.text.secondary,
            fontSize: '14px',
          }}
        >
          <div>{openTimedOut ? t('common.fileNotFound') : t('explorer.loadingEditor')}</div>
          <div style={{ fontSize: '12px', opacity: 0.7 }}>{path}</div>
        </div>
      )}
    </div>
  );
};

const MonacoDiffEditorLazy = React.lazy(() => import('./MonacoDiffEditor'));

export default MonacoEditor;
