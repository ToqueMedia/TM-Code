import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import { useMonacoEditorState } from '../../hooks/useEditorState';
import { useMonacoTheme } from '../../hooks/useMonacoTheme';
import type { editor, IDisposable } from 'monaco-editor';
import { tokens } from '@/theme/tokens';
import { logger } from '../../utils/logger';
import MonacoBridge from '../../utils/monacoBridge';
import { useSettingsStore } from '../../stores/settingsStore';

// Import Monaco workers for Vite
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Monaco Editor environment configuration
declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker;
    };
  }
}

// Configure Monaco workers and global theme initialization
if (typeof window !== 'undefined') {
  window.MonacoEnvironment = {
    getWorker: function (_workerId: string, label: string) {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    }
  };
  
  // Global flag to track if themes are defined
  (window as unknown as { toqueMediaThemesDefined: boolean }).toqueMediaThemesDefined = false;
}

interface MonacoEditorProps {
  path: string;
  onCursorPositionChange?: (line: number, column: number) => void;
}

const MonacoEditor: React.FC<MonacoEditorProps> = ({ path, onCursorPositionChange }) => {
  // Get file state from our editor store
  const {
    content,
    language,
    exists,
    handleContentChange,
    handleCursorChange,
    handleSave,
  } = useMonacoEditorState(path);

  // Refs for editor instance
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const pendingRevealRef = useRef<{ file: string; line: number; column: number } | null>(null);
  const [monacoInstance, setMonacoInstance] = useState<Monaco | null>(null);

  // Stable refs for callbacks — prevents Monaco from unbinding/rebinding
  // listeners on every re-render. The refs always point to the latest
  // version of the callback without changing identity.
  const handleContentChangeRef = useRef(handleContentChange);
  handleContentChangeRef.current = handleContentChange;
  const handleCursorChangeRef = useRef(handleCursorChange);
  handleCursorChangeRef.current = handleCursorChange;
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  const onCursorPositionChangeRef = useRef(onCursorPositionChange);
  onCursorPositionChangeRef.current = onCursorPositionChange;
  
  // Use the custom theme management hook
  useMonacoTheme(editorRef.current, monacoInstance);
  // Read indentation settings
  const tabSizeSetting = useSettingsStore(function (s) { return s.editor.tabSize })
  const insertSpacesSetting = useSettingsStore(function (s) { return s.editor.insertSpaces })
  const detectIndentationSetting = useSettingsStore(function (s) { return s.editor.detectIndentation })
  
  // Monaco Editor options following official documentation best practices
  const editorOptions: editor.IStandaloneEditorConstructionOptions = useMemo(() => ({
    // Basic editor options
    automaticLayout: true,
    fontSize: 14,
    fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
    lineHeight: 20,
    tabSize: tabSizeSetting,
    insertSpaces: insertSpacesSetting,
    detectIndentation: detectIndentationSetting,
    
    // Theme and appearance - will be set after custom themes are defined
    theme: 'toquemedia-vibrant',
    
    // Scrolling and layout
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
      verticalHasArrows: false,
      horizontalHasArrows: false,
    },
    
    // Minimap
    minimap: {
      enabled: true,
      side: 'right',
      showSlider: 'always',
      renderCharacters: false,
    },
    
    // Cursor and selection
    cursorBlinking: 'blink',
    cursorSmoothCaretAnimation: 'on',
    selectionHighlight: true,
    occurrencesHighlight: 'singleFile',
    
    // Code assistance
    quickSuggestions: {
      other: 'on',
      comments: 'on',
      strings: 'on',
    },
    wordBasedSuggestions: 'currentDocument',
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnCommitCharacter: true,
    acceptSuggestionOnEnter: 'on',
    snippetSuggestions: 'top',
    
    // Code formatting
    formatOnType: false,
    formatOnPaste: false,
    autoIndent: 'full',
    
    // Code folding
    folding: true,
    foldingStrategy: 'auto',
    showFoldingControls: 'mouseover',
    foldingHighlight: true,
    
    // Bracket matching and colorization
    matchBrackets: 'always',
    bracketPairColorization: {
      enabled: true,
      independentColorPoolPerBracketType: true,
    },
    
    // Indentation guides
    guides: {
      bracketPairs: true,
      indentation: true,
      highlightActiveIndentation: true,
    },
    
    // Other features
    hover: {
      enabled: true,
      delay: 300,
      sticky: true,
    },
    links: true,
    colorDecorators: true,
    codeLens: false, // Disable for better performance
    contextmenu: true,
    
    // Accessibility
    accessibilitySupport: 'auto',
    
    // Find widget
    find: {
      seedSearchStringFromSelection: 'never',
      autoFindInSelection: 'never',
      addExtraSpaceOnTop: false,
    },
    
    // Render options
    renderWhitespace: 'none',
    renderControlCharacters: false,
    renderLineHighlight: 'line',
    // renderIndentGuides: true, // Removed - not in current Monaco API
    
    // Multi-cursor
    multiCursorModifier: 'alt',
    multiCursorPaste: 'spread',
  }), [tabSizeSetting, insertSpacesSetting, detectIndentationSetting]);
  
  // Update editor options when indentation settings change
  useEffect(() => {
    const inst = editorRef.current
    if (!inst) return
    try {
      inst.updateOptions({
        tabSize: tabSizeSetting,
        insertSpaces: insertSpacesSetting,
        detectIndentation: detectIndentationSetting,
      })
      const model = inst.getModel?.()
      if (model) {
        if (detectIndentationSetting) {
          // Let Monaco infer indentation from content using our defaults
          ;(model as unknown as { detectIndentation(insertSpaces: boolean, tabSize: number): void })
            .detectIndentation(insertSpacesSetting, tabSizeSetting)
        } else {
          model.updateOptions({
            tabSize: tabSizeSetting,
            indentSize: tabSizeSetting,
            insertSpaces: insertSpacesSetting,
          })
        }
      }
    } catch (e) {
      logger.error('editor', 'Failed to update editor options:', e)
    }
  }, [tabSizeSetting, insertSpacesSetting, detectIndentationSetting])
  
  // Cleanup disposables when editor unmounts or changes
  const disposablesRef = useRef<IDisposable[]>([]);
  useEffect(() => {
    return () => {
      disposablesRef.current.forEach(d => d.dispose());
      disposablesRef.current = [];
      const inst = editorRef.current;
      if (inst) {
        const bridge = MonacoBridge.getInstance();
        if (bridge.getCurrentEditor() === inst) {
          bridge.setCurrentEditor(null);
        }
      }
    };
  }, [path]);

  // Handle editor mounting — uses refs so this callback never changes identity,
  // preventing Monaco from re-mounting or rebinding listeners.
  const handleEditorDidMount = useCallback((editor: editor.IStandaloneCodeEditor, monaco: Monaco) => {
    logger.editor(`Monaco Editor mounted successfully for: ${path}`);
    // Dispose previous listeners before setting new ones
    disposablesRef.current.forEach(d => d.dispose());
    disposablesRef.current = [];
    editorRef.current = editor;
    setMonacoInstance(monaco);
    MonacoBridge.getInstance().setCurrentEditor(editor);

    // Configure TypeScript compiler options if it's a TypeScript file
    if (language === 'typescript' || language === 'javascript') {
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2020,
        allowNonTsExtensions: true,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        noEmit: true,
        typeRoots: ['node_modules/@types'],
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      });

      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        diagnosticCodesToIgnore: [1108],
      });

      monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
      monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
    }

    // Dispatch supported languages to app
    try {
      const languages = monaco.languages.getLanguages().map((l: { id: string }) => l.id);
      window.dispatchEvent(new CustomEvent('monaco:languages', { detail: languages }));
    } catch {}

    // Cursor position change — read from ref so closure stays fresh
    disposablesRef.current.push(
      editor.onDidChangeCursorPosition((e) => {
        const { lineNumber, column } = e.position;
        handleCursorChangeRef.current(lineNumber, column);
        onCursorPositionChangeRef.current?.(lineNumber, column);
      })
    );

    // Content change — read from ref
    disposablesRef.current.push(
      editor.onDidChangeModelContent(() => {
        const value = editor.getValue();
        handleContentChangeRef.current(value);
      })
    );

    // Keyboard shortcuts — read from ref
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        handleSaveRef.current().catch(error => {
          logger.error('editor', 'Failed to save file', error);
        });
      }
    );

    // Apply pending reveal position
    if (pendingRevealRef.current && pendingRevealRef.current.file === path) {
      const { line, column } = pendingRevealRef.current;
      editor.setPosition({ lineNumber: line, column });
      editor.revealLineInCenter(line);
      pendingRevealRef.current = null;
    }

    editor.focus();
  }, [path, language]); // Only re-create on file/language change — callbacks via refs

  // Stable onChange for @monaco-editor/react — identity never changes
  const handleChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      handleContentChangeRef.current(value);
    }
  }, []);
  
  // Sync content from store when changed externally (e.g. agent writes a file).
  // We use defaultValue so Monaco owns its state, but external updates
  // (where the store content differs from what Monaco has) need to be pushed in.
  const lastSyncedContentRef = useRef(content);
  useEffect(() => {
    const inst = editorRef.current;
    if (!inst) return;
    // Only sync if content was changed externally (not by user typing)
    if (content !== lastSyncedContentRef.current) {
      const currentValue = inst.getValue();
      if (content !== currentValue) {
        // Preserve cursor position across external updates
        const pos = inst.getPosition();
        inst.setValue(content || '');
        if (pos) inst.setPosition(pos);
      }
      lastSyncedContentRef.current = content;
    }
  }, [content]);

  // Track user edits so we can distinguish them from external syncs
  const origHandleChange = handleChange;
  const stableHandleChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      lastSyncedContentRef.current = value;
    }
    origHandleChange(value);
  }, [origHandleChange]);

  // Focus editor when path changes
  useEffect(() => {
    if (editorRef.current) {
      MonacoBridge.getInstance().setCurrentEditor(editorRef.current)
      editorRef.current.focus();
    }
  }, [path]);

  // Listen for external "go to line" requests (e.g. from Problems panel).
  // Stores the latest pending request so it can be applied after mount.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { file: string; line: number; column: number } | undefined;
      if (!detail || detail.file !== path) return;
      if (editorRef.current) {
        editorRef.current.setPosition({ lineNumber: detail.line, column: detail.column });
        editorRef.current.revealLineInCenter(detail.line);
        editorRef.current.focus();
      } else {
        // Editor not mounted yet — store for when it mounts
        pendingRevealRef.current = detail;
      }
    };
    window.addEventListener('monaco:revealPosition', handler);
    return () => window.removeEventListener('monaco:revealPosition', handler);
  }, [path]);
  
  // Show loading state for files that don't exist yet
  if (!exists) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100%', 
        color: tokens.colors.text.secondary,
        fontSize: '14px',
        flexDirection: 'column',
        gap: '8px'
      }}>
        <div>File not found</div>
        <div style={{ fontSize: '12px', opacity: 0.7 }}>{path}</div>
      </div>
    );
  }
  
  // Debug log for content
  logger.editor(`Monaco Editor [${path}]`, {
    hasContent: !!content,
    contentLength: content?.length || 0,
    language,
    exists
  });
  
  return (
    <div style={{ height: '100%', width: '100%' }}>
      <Editor
        height="100%"
        defaultLanguage={language}
        language={language}
        path={path}
        defaultValue={content || ''}
        onChange={stableHandleChange}
        onMount={handleEditorDidMount}
        options={editorOptions}
        theme="toquemedia-vibrant"
        loading={
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            height: '100%', 
            color: tokens.colors.text.secondary,
            fontSize: '14px'
          }}>
            Loading Monaco Editor...
          </div>
        }
      />
    </div>
  );
};

export default MonacoEditor;