import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { useMonacoEditorState } from '../../hooks/useEditorState';
import type { editor } from 'monaco-editor';
import { KeyCode, KeyMod } from 'monaco-editor';
import TypeScriptLspService from '../../services/typescriptLspService';

// Configure TypeScript language service
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Initialize Monaco workers with proper typing
declare global {
  interface Window {
    MonacoEnvironment: any;
  }
}

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

interface MonacoEditorProps {
  path: string;
  onCursorPositionChange?: (line: number, column: number) => void;
}

const MonacoEditor: React.FC<MonacoEditorProps> = ({ path, onCursorPositionChange }) => {
  const {
    content,
    language,
    exists,
    handleContentChange,
    handleCursorChange,
    handleSave,
    handleUndo,
    handleRedo,
  } = useMonacoEditorState(path);
  
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const lspServiceRef = useMemo(() => TypeScriptLspService.getInstance(), []);
  
  
  const handleEditorDidMount = useCallback((editor: editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;
    
    // Set up cursor position tracking
    const cursorDisposable = editor.onDidChangeCursorPosition((e: editor.ICursorPositionChangedEvent) => {
      const position = e.position;
      handleCursorChange(position.lineNumber, position.column);
      if (onCursorPositionChange) {
        onCursorPositionChange(position.lineNumber, position.column);
      }
    });
    
    // Set up keyboard shortcuts for undo/redo
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, () => {
      handleUndo();
    });
    
    editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, () => {
      handleRedo();
    });
    
    // On Windows/Linux, Ctrl+Y is redo
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => {
      handleRedo();
    });
    
    // Save file with Ctrl+S
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, async () => {
      try {
        await handleSave();
        // Update LSP service with new content
        if (content) {
          await lspServiceRef.updateFileContent(path, content);
        }
      } catch (error) {
        console.error('Failed to save file:', error);
      }
    });
    
    // Trigger auto-formatting on blur
    const blurDisposable = editor.onDidBlurEditorText(async () => {
      try {
        await editor.getAction('editor.action.formatDocument')?.run();
      } catch (error) {
        console.error('Failed to format document:', error);
      }
    });
    
    // Store disposables for cleanup
    return () => {
      cursorDisposable?.dispose();
      blurDisposable?.dispose();
    };
  }, [handleCursorChange, onCursorPositionChange, handleUndo, handleRedo, handleSave, content, lspServiceRef, path]);
  
  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      handleContentChange(value);
      
      // Update LSP service with new content
      lspServiceRef.updateFileContent(path, value);
    }
  }, [handleContentChange, lspServiceRef, path]);
  
  // Focus the editor when it becomes active
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.focus();
    }
  }, [path]);
  
  // Monaco editor options - Memoizado para evitar re-criação
  // MUST be declared BEFORE any early returns to respect React hooks rules
  const editorOptions = useMemo(() => ({
    automaticLayout: true,
    minimap: { 
      enabled: true,
      showSlider: 'always' as const,
      renderCharacters: false
    },
    scrollBeyondLastLine: false,
    fontSize: 14,
    tabSize: 2,
    insertSpaces: true,
    wordWrap: 'on' as const,
    smoothScrolling: true,
    cursorBlinking: 'smooth' as const,
    fontLigatures: true,
    suggest: {
      showKeywords: true,
      showSnippets: true,
      showClasses: true,
      showInterfaces: true,
      showFunctions: true,
      showVariables: true,
      showProperties: true,
      showEvents: true,
      showOperators: true,
      showUnits: true,
      showValues: true,
      showConstants: true,
      showEnums: true,
      showEnumMembers: true,
      showWords: true,
      showColors: true,
      showFiles: true,
      showReferences: true,
      showFolders: true,
      showTypeParameters: true,
      showUsers: true,
      showIssues: true
    },
    quickSuggestions: {
      other: 'on' as const,
      comments: 'off' as const,
      strings: 'off' as const
    },
    formatOnType: true,
    formatOnPaste: true,
    autoIndent: 'full' as const,
    detectIndentation: true,
    renderWhitespace: 'boundary' as const,
    renderControlCharacters: false,
    renderLineHighlight: 'all' as const,
    scrollbar: {
      vertical: 'auto' as const,
      horizontal: 'auto' as const,
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10
    },
    find: {
      addExtraSpaceOnTop: false,
      autoFindInSelection: 'never' as const,
      seedSearchStringFromSelection: 'never' as const
    },
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnCommitCharacter: true,
    acceptSuggestionOnEnter: 'on' as const,
    accessibilitySupport: 'auto' as const,
    codeLens: true,
    colorDecorators: true,
    copyWithSyntaxHighlighting: true,
    hover: {
      enabled: true,
      delay: 300,
      sticky: true
    },
    links: true,
    multiCursorModifier: 'alt' as const,
    multiCursorPaste: 'spread' as const,
    occurrencesHighlight: 'singleFile' as const,
    overviewRulerBorder: true,
    selectionHighlight: true,
    showFoldingControls: 'mouseover' as const,
    folding: true,
    foldingHighlight: true,
    foldingStrategy: 'auto' as const,
    showUnused: true,
    snippetSuggestions: 'top' as const,
    lineHeight: 22,
    mouseWheelZoom: true,
    stickyTabStops: true
  }), []);
  
  // Early return MUST come after all hooks
  if (!exists) {
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100%', 
        color: '#8b949e',
        fontSize: '14px'
      }}>
        File not found
      </div>
    );
  }
  
  return (
    <Editor
      height="100%"
      language={language}
      value={content}
      onChange={handleEditorChange}
      onMount={handleEditorDidMount}
      theme="vs-dark"
      options={editorOptions}
    />
  );
};

export default MonacoEditor;