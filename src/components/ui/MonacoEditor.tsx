import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import Editor, { Monaco, loader } from '@monaco-editor/react';
import * as monacoEditor from 'monaco-editor';
import type { editor, IDisposable } from 'monaco-editor';

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
  groupId?: string;
  onCursorPositionChange?: (line: number, column: number) => void;
}

const MonacoEditor: React.FC<MonacoEditorProps> = ({ path, groupId = 'main', onCursorPositionChange }) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const pathRef = useRef(path);
  const prevPathRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);
  const cursorCbRef = useRef(onCursorPositionChange);
  const pendingRef = useRef<{ path: string; content: string } | null>(null);
  const gutterCollectionRef = useRef<editor.IEditorDecorationsCollection | null>(null);

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
    contextmenu: false,
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
            const lineCount = model.getLineCount();
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
      if (!inst) {
        console.warn('[MonacoEditor:doSave] No editor instance');
        return;
      }

      const savePath = pathRef.current;

      // Format on save — best-effort, never blocks save
      const { formatOnSave } = useSettingsStore.getState();
      if (formatOnSave) {
        try { await doFormat(); } catch {}
      }

      try {
        const content = inst.getValue();
        pendingRef.current = { path: savePath, content };
        await FileService.writeFile(savePath, content);
        dirtyRef.current = false;
      } catch (e) {
        logger.error('editor', 'Save failed', e);
        pendingRef.current = null;
      }

      // Refresh git gutter after save
      updateGitGutter(inst);
    };

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { doSave(); });
    ed.addAction({ id: 'tmcode.save', label: 'Save', run: () => { doSave(); } });

    // Override Monaco's Go to Line / Quick Outline — their QuickInput widgets freeze in Tauri WebView
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () => {});
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO, () => {});

    // Content change — autosave directly to disk, then refresh git gutter
    // Uses pathRef.current (not boundPath) so it works across model swaps
    let saveGeneration = 0;
    disposablesRef.current.push(
      ed.onDidChangeModelContent(() => {
        dirtyRef.current = true;
        saveGeneration++;
        if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
        autoSaveRef.current = setTimeout(() => {
          autoSaveRef.current = null;
          const savePath = pathRef.current;
          const inst = editorRef.current;
          if (!inst || !savePath) return;
          const gen = saveGeneration;
          try {
            const content = inst.getValue();
            pendingRef.current = { path: savePath, content };
            FileService.writeFile(savePath, content).then(() => {
              if (gen === saveGeneration) {
                dirtyRef.current = false;
              }
              if (editorRef.current) updateGitGutter(editorRef.current);
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

    // Initial model setup — create model for the initial file
    // Dispose the empty placeholder model created by @monaco-editor/react
    const placeholderModel = ed.getModel();
    const initialFile = useEditorRepository.getState().openFiles.find(f => f.path === boundPath);
    if (initialFile) {
      const uri = monacoEditor.Uri.file(boundPath);
      let model = monacoEditor.editor.getModel(uri);
      if (!model) {
        model = monacoEditor.editor.createModel(initialFile.content, initialFile.language, uri);
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
    prevPathRef.current = boundPath;

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
  }, [updateGitGutter]);

  // ── Model swap on tab switch (VS Code-style) ────────────────────────

  useEffect(() => {
    const inst = editorRef.current;
    if (!inst) return;

    const prevPath = prevPathRef.current;
    prevPathRef.current = path;

    // Same file — nothing to do
    if (prevPath === path) return;

    // Save cursor from previous model
    if (prevPath) {
      try {
        const pos = inst.getPosition();
        if (pos) setCursorCached(`${groupId}::${prevPath}`, { line: pos.lineNumber, col: pos.column });
      } catch {}
      // Save content of previous model to store
      try {
        const prevModel = inst.getModel();
        if (prevModel) pushContentToStore(prevPath, prevModel.getValue());
      } catch {}
    }

    // Get or create model for the new file
    const file = useEditorRepository.getState().openFiles.find(f => f.path === path);
    if (!file) return;

    const uri = monacoEditor.Uri.file(path);
    let model = monacoEditor.editor.getModel(uri);
    if (!model) {
      model = monacoEditor.editor.createModel(file.content, file.language, uri);
    }

    // Swap model (near-instant — no parsing, no re-tokenizing if cached)
    inst.setModel(model);

    // Restore cursor
    const cached = cursorCache.get(`${groupId}::${path}`);
    if (cached) {
      inst.setPosition({ lineNumber: cached.line, column: cached.col });
      inst.revealLineInCenter(cached.line);
    }

    inst.focus();

    // Update git gutter for the new file
    updateGitGutter(inst);
  }, [path, groupId, updateGitGutter]);

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

      // Flush autosave
      if (autoSaveRef.current) { clearTimeout(autoSaveRef.current); autoSaveRef.current = null; }
      disposablesRef.current.forEach(d => d.dispose());
      disposablesRef.current = [];

      // Save content on unmount
      if (inst && currentPath) {
        let content: string | null = null;
        try { content = inst.getValue() ?? null; } catch {}
        if (!content && pendingRef.current?.path === currentPath) content = pendingRef.current.content;
        if (content) {
          FileService.writeFile(currentPath, content).catch(e =>
            logger.error('editor', 'Save on unmount failed', e)
          );
          pushContentToStore(currentPath, content);
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
      // Only sync if content changed in store and differs from model
      if (file.content !== prevFile.content) {
        const model = editorRef.current.getModel();
        if (model && model.getValue() !== file.content) {
          // Preserve cursor position across the update
          const pos = editorRef.current.getPosition();
          model.setValue(file.content);
          if (pos) editorRef.current.setPosition(pos);
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

  const store = useEditorRepository.getState();
  const file = store.openFiles.find(f => f.path === path);
  if (!file) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: tokens.colors.text.secondary, fontSize: '14px', flexDirection: 'column', gap: '8px' }}>
        <div>{t("common.fileNotFound")}</div>
        <div style={{ fontSize: '12px', opacity: 0.7 }}>{path}</div>
      </div>
    );
  }

  // Diff mode — render side-by-side diff editor
  if (file.diff) {
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

  return (
    <div style={{ height: '100%', width: '100%' }}>
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
    </div>
  );
};

const MonacoDiffEditorLazy = React.lazy(() => import('./MonacoDiffEditor'));

export default MonacoEditor;
