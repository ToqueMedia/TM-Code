import React, { useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { useEditorRepository } from '../../stores/editorStore';
import type { editor } from 'monaco-editor';
import { KeyCode, KeyMod } from 'monaco-editor';
import { FileService } from '../../services/fileService';
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
  const { openFiles, updateFileContent, setCursorPosition, undo, redo, updateEditorState } = useEditorRepository();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const lspServiceRef = useRef(TypeScriptLspService.getInstance());
  
  const file = openFiles.find(f => f.path === path);
  
  // Determine language based on file extension
  const getLanguage = (filePath: string): string => {
    const extension = filePath.split('.').pop()?.toLowerCase() || '';
    switch (extension) {
      case 'js':
      case 'jsx':
        return 'javascript';
      case 'ts':
      case 'tsx':
        return 'typescript';
      case 'json':
        return 'json';
      case 'html':
        return 'html';
      case 'css':
        return 'css';
      case 'scss':
        return 'scss';
      case 'md':
        return 'markdown';
      case 'py':
        return 'python';
      case 'java':
        return 'java';
      case 'cpp':
      case 'cc':
      case 'cxx':
        return 'cpp';
      case 'c':
        return 'c';
      case 'rs':
        return 'rust';
      case 'go':
        return 'go';
      case 'php':
        return 'php';
      case 'sql':
        return 'sql';
      default:
        return 'plaintext';
    }
  };
  
  const handleEditorDidMount = (editor: editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;
    
    // Set up cursor position tracking
    editor.onDidChangeCursorPosition((e) => {
      const position = e.position;
      setCursorPosition(path, position.lineNumber, position.column);
      if (onCursorPositionChange) {
        onCursorPositionChange(position.lineNumber, position.column);
      }
      
      // Save cursor position to editor state
      updateEditorState(path, {
        cursorPosition: { line: position.lineNumber, column: position.column }
      });
    });
    
    // Set up keyboard shortcuts for undo/redo
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, () => {
      undo(path);
    });
    
    editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, () => {
      redo(path);
    });
    
    // On Windows/Linux, Ctrl+Y is redo
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => {
      redo(path);
    });
    
    // Save file with Ctrl+S
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, async () => {
      try {
        // Get the current file content from the editor state, not from the closure
        const currentFile = openFiles.find(f => f.path === path);
        if (currentFile) {
          await FileService.writeFile(path, currentFile.content);
          // Update file state to mark as not dirty
          updateEditorState(path, { isDirty: false });
          
          // Update LSP service with new content
          await lspServiceRef.current.updateFileContent(path, currentFile.content);
        }
      } catch (error) {
        console.error('Failed to save file:', error);
      }
    });
    
    // Trigger auto-formatting on save
    editor.onDidBlurEditorText(async () => {
      try {
        await editor.getAction('editor.action.formatDocument')?.run();
      } catch (error) {
        console.error('Failed to format document:', error);
      }
    });
  };
  
  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined) {
      updateFileContent(path, value);
      
      // Update LSP service with new content
      lspServiceRef.current.updateFileContent(path, value);
    }
  };
  
  // Focus the editor when it becomes active
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.focus();
    }
  }, [path]);
  
  // Early return must come after all hooks
  if (!file) {
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
  
  // Get the language for this file
  const language = getLanguage(path);
  
  return (
    <Editor
      height="100%"
      language={language}
      value={file.content}
      onChange={handleEditorChange}
      onMount={handleEditorDidMount}
      theme="vs-dark"
      options={{
        automaticLayout: true,
        minimap: { 
          enabled: true,
          showSlider: 'always',
          renderCharacters: false
        },
        scrollBeyondLastLine: false,
        fontSize: 14,
        tabSize: 2,
        insertSpaces: true,
        wordWrap: 'on',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
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
          other: 'on',
          comments: 'off',
          strings: 'off'
        },
        formatOnType: true,
        formatOnPaste: true,
        autoIndent: 'full',
        detectIndentation: true,
        renderWhitespace: 'boundary',
        renderControlCharacters: false,
        renderLineHighlight: 'all',
        scrollbar: {
          vertical: 'auto',
          horizontal: 'auto',
          verticalScrollbarSize: 10,
          horizontalScrollbarSize: 10
        },
        find: {
          addExtraSpaceOnTop: false,
          autoFindInSelection: 'never',
          seedSearchStringFromSelection: 'never'
        },
        suggestOnTriggerCharacters: true,
        acceptSuggestionOnCommitCharacter: true,
        acceptSuggestionOnEnter: 'on',
        accessibilitySupport: 'auto',
        codeLens: true,
        colorDecorators: true,
        copyWithSyntaxHighlighting: true,
        hover: {
          enabled: true,
          delay: 300,
          sticky: true
        },
        links: true,
        multiCursorModifier: 'alt',
        multiCursorPaste: 'spread',
        occurrencesHighlight: 'singleFile',
        overviewRulerBorder: true,
        selectionHighlight: true,
        showFoldingControls: 'mouseover',
        folding: true,
        foldingHighlight: true,
        foldingStrategy: 'auto',
        showUnused: true,
        snippetSuggestions: 'top',
        lineHeight: 22,
        mouseWheelZoom: true,
        stickyTabStops: true
      }}
    />
  );
};

export default MonacoEditor;