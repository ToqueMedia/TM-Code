import React, { useRef, useEffect, useCallback, useState } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import { useMonacoEditorState } from '../../hooks/useEditorState';
import { useMonacoTheme } from '../../hooks/useMonacoTheme';
import type { editor, IDisposable } from 'monaco-editor';
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
  (window as any).toqueMediaThemesDefined = false;
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
  const [monacoInstance, setMonacoInstance] = useState<Monaco | null>(null);
  
  // Use the custom theme management hook
  useMonacoTheme(editorRef.current, monacoInstance);
  // Read indentation settings
  const tabSizeSetting = useSettingsStore(function (s) { return s.editor.tabSize })
  const insertSpacesSetting = useSettingsStore(function (s) { return s.editor.insertSpaces })
  const detectIndentationSetting = useSettingsStore(function (s) { return s.editor.detectIndentation })
  
  // Monaco Editor options following official documentation best practices
  const editorOptions: editor.IStandaloneEditorConstructionOptions = {
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
  };
  
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
          // @ts-ignore - detectIndentation exists on ITextModel
          model.detectIndentation(insertSpacesSetting, tabSizeSetting)
        } else {
          model.updateOptions({
            tabSize: tabSizeSetting,
            indentSize: tabSizeSetting,
            insertSpaces: insertSpacesSetting,
          })
        }
      }
    } catch {}
  }, [tabSizeSetting, insertSpacesSetting, detectIndentationSetting])
  
  // Handle editor mounting
  const handleEditorDidMount = useCallback((editor: editor.IStandaloneCodeEditor, monaco: Monaco) => {
    logger.editor(`Monaco Editor mounted successfully for: ${path}`);
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
      
      // Enable strict null checks and other strict options
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        diagnosticCodesToIgnore: [1108], // Ignore 'return statement not in function' errors
      });

      // Ensure model sync for better IntelliSense responsiveness
      monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
      monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
    }
    
    // Set up event listeners
    const disposables: IDisposable[] = [];

    // Dispatch supported languages to app
    try {
      const languages = monaco.languages.getLanguages().map(l => l.id);
      window.dispatchEvent(new CustomEvent('monaco:languages', { detail: languages }));
    } catch {}
    
    // Cursor position change
    disposables.push(
      editor.onDidChangeCursorPosition((e) => {
        const { lineNumber, column } = e.position;
        handleCursorChange(lineNumber, column);
        onCursorPositionChange?.(lineNumber, column);
      })
    );
    
    // Content change
    disposables.push(
      editor.onDidChangeModelContent(() => {
        const value = editor.getValue();
        handleContentChange(value);
      })
    );
    
    // Add keyboard shortcuts
    const saveCommand = editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        handleSave().catch(error => {
          logger.error('editor', 'Failed to save file', error);
        });
      }
    );
    
    if (saveCommand) {
      disposables.push({ dispose: () => {} }); // Command disposable is managed by Monaco
    }
    
    // Focus the editor
    editor.focus();
    
    // Return cleanup function
    return () => {
      disposables.forEach(disposable => disposable.dispose());
      const bridge = MonacoBridge.getInstance()
      if (bridge.getCurrentEditor() === editor) {
        bridge.setCurrentEditor(null)
      }
    };
  }, [path, language, handleContentChange, handleCursorChange, handleSave, onCursorPositionChange]);
  
  // Handle content changes
  const handleChange = useCallback((value: string | undefined) => {
    if (value !== undefined && value !== content) {
      handleContentChange(value);
    }
  }, [content, handleContentChange]);
  
  // Focus editor when path changes
  useEffect(() => {
    if (editorRef.current) {
      MonacoBridge.getInstance().setCurrentEditor(editorRef.current)
      editorRef.current.focus();
    }
  }, [path]);
  
  // Show loading state for files that don't exist yet
  if (!exists) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100%', 
        color: '#8b949e',
        fontSize: '14px',
        flexDirection: 'column',
        gap: '8px'
      }}>
        <div>📄 File not found</div>
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
        value={content || ''}
        onChange={handleChange}
        onMount={handleEditorDidMount}
        options={editorOptions}
        theme="toquemedia-vibrant"
        loading={
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            height: '100%', 
            color: '#8b949e',
            fontSize: '14px'
          }}>
            ⚡ Loading Monaco Editor...
          </div>
        }
      />
    </div>
  );
};

export default MonacoEditor;