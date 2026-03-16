import type { editor } from 'monaco-editor';

// ToqueMedia Studio Custom Theme - Cores vibrantes e modernas
export const toqueMediaTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // JavaScript/TypeScript Keywords - Roxo vibrante
    { token: 'keyword.js', foreground: '#c547f7', },
    { token: 'keyword.ts', foreground: '#c43eb4',  },
    { token: 'keyword.control.js', foreground: '#8b5cf6', fontStyle: 'bold' },
    { token: 'keyword.control.ts', foreground: '#8b5cf6', fontStyle: 'bold' },
    { token: 'keyword.operator.js', foreground: '#c084fc', fontStyle: 'bold' },
    { token: 'keyword.operator.ts', foreground: '#c084fc', fontStyle: 'bold' },
    
    // Palavras-reservadas gerais - Roxo negrito
    { token: 'keyword', foreground: '#c547f7', fontStyle: 'bold' },
    { token: 'keyword.control', foreground: '#8b5cf6', fontStyle: 'bold' },
    { token: 'keyword.operator', foreground: '#c084fc', fontStyle: 'bold' },
    { token: 'keyword.other', foreground: '#7c3aed', fontStyle: 'bold' },
    { token: 'storage.type', foreground: '#c547f7', fontStyle: 'bold' }, // var, let, const, function
    { token: 'storage.modifier', foreground: '#8b5cf6', fontStyle: 'bold' }, // public, private, static
    
    // Tipos e classes - Roxo elegante
    { token: 'type', foreground: '#a78bfa', fontStyle: 'bold' },
    { token: 'type.identifier', foreground: '#c084fc' },
    { token: 'entity.name.type', foreground: '#8b5cf6' },
    { token: 'entity.name.class', foreground: '#7c3aed', fontStyle: 'bold' },
    { token: 'support.type', foreground: '#a78bfa', fontStyle: 'bold' }, // built-in types
    
    // Strings - Verde vibrante
    { token: 'string', foreground: '#50fa7b' }, // Bright green
    { token: 'string.quoted', foreground: '#50fa7b' },
    { token: 'string.template', foreground: '#8be9fd' }, // Cyan for template strings
    
    // Números - Laranja brilhante
    { token: 'number', foreground: '#ffb86c' }, // Orange
    { token: 'number.hex', foreground: '#ff9f43' },
    { token: 'number.binary', foreground: '#feca57' },
    
    // Comentários - Cinza azulado suave
    { token: 'comment', foreground: '#6272a4', fontStyle: 'italic' },
    { token: 'comment.line', foreground: '#6272a4', fontStyle: 'italic' },
    { token: 'comment.block', foreground: '#6272a4', fontStyle: 'italic' },
    
    // Funções - Amarelo dourado
    { token: 'entity.name.function', foreground: '#f1fa8c', fontStyle: 'bold' },
    { token: 'support.function', foreground: '#f1fa8c' },
    { token: 'meta.function-call', foreground: '#f1fa8c' },
    
    // Variáveis - Branco puro
    { token: 'variable', foreground: '#f8f8f2' },
    { token: 'variable.parameter', foreground: '#ffb86c', fontStyle: 'italic' },
    { token: 'variable.other', foreground: '#f8f8f2' },
    
    // Constantes - Rosa vibrante
    { token: 'constant', foreground: '#ff79c6', fontStyle: 'bold' },
    { token: 'constant.language', foreground: '#ff79c6', fontStyle: 'bold' },
    { token: 'constant.numeric', foreground: '#bd93f9' },
    
    // Operadores - Ciano
    { token: 'operator', foreground: '#8be9fd' },
    { token: 'delimiter', foreground: '#8be9fd' },
    { token: 'punctuation', foreground: '#8be9fd' },
    
    // Tags HTML/JSX - Verde limão
    { token: 'tag', foreground: '#50fa7b', fontStyle: 'bold' },
    { token: 'tag.name', foreground: '#50fa7b', fontStyle: 'bold' },
    { token: 'tag.attribute.name', foreground: '#f1fa8c' },
    { token: 'tag.attribute.value', foreground: '#50fa7b' },
    
    // CSS/SCSS - Cores específicas
    { token: 'attribute.name.css', foreground: '#8be9fd' },
    { token: 'attribute.value.css', foreground: '#50fa7b' },
    { token: 'property.css', foreground: '#f1fa8c' },
    { token: 'value.css', foreground: '#50fa7b' },
    
    // JSON - Cores diferenciadas
    { token: 'key.json', foreground: '#8be9fd', fontStyle: 'bold' },
    { token: 'value.json', foreground: '#50fa7b' },
    
    // TypeScript específico - Keywords fundamentais
    { token: 'keyword.typescript', foreground: '#c547f7', fontStyle: 'bold' },
    { token: 'type.typescript', foreground: '#c084fc', fontStyle: 'bold' },
    { token: 'interface.typescript', foreground: '#8b5cf6', fontStyle: 'bold' },
    { token: 'storage.type.ts', foreground: '#c547f7', fontStyle: 'bold' }, // var, let, const
    { token: 'storage.type.function.ts', foreground: '#c547f7', fontStyle: 'bold' },
    { token: 'keyword.control.import.ts', foreground: '#c547f7', fontStyle: 'bold' },
    { token: 'keyword.control.export.ts', foreground: '#c547f7', fontStyle: 'bold' },
    
    // JavaScript específico - Keywords fundamentais
    { token: 'keyword.javascript', foreground: '#c547f7', fontStyle: 'bold' },
    { token: 'this.javascript', foreground: '#c084fc', fontStyle: 'bold' },
    { token: 'variable.language.this.js', foreground: '#c084fc', fontStyle: 'bold' },
    { token: 'storage.type.js', foreground: '#c547f7', fontStyle: 'bold' }, // var, let, const
    { token: 'storage.type.function.js', foreground: '#c547f7', fontStyle: 'bold' },
    
    // Markdown
    { token: 'emphasis.markdown', foreground: '#f1fa8c', fontStyle: 'italic' },
    { token: 'strong.markdown', foreground: '#ff79c6', fontStyle: 'bold' },
    { token: 'heading.markdown', foreground: '#61dafb', fontStyle: 'bold' },
    
    // Errors e warnings
    { token: 'invalid', foreground: '#ff5555', background: '#44475a' },
    { token: 'invalid.deprecated', foreground: '#ffb86c', background: '#44475a' },
  ],
  colors: {
    // Editor background
    'editor.background': '#24262c',
    'editor.foreground': '#f8f8f2',
    
    // Line numbers
    'editorLineNumber.foreground': '#6272a4',
    'editorLineNumber.activeForeground': '#f8f8f2',
    
    // Cursor
    'editorCursor.foreground': '#f8f8f2',
    
    // Selection
    'editor.selectionBackground': '#44475a',
    'editor.selectionHighlightBackground': '#44475a75',
    
    // Find/search
    'editor.findMatchBackground': '#ffb86c',
    'editor.findMatchHighlightBackground': '#f1fa8c50',
    
    // Current line
    'editor.lineHighlightBackground': '#44475a50',
    
    // Brackets
    'editorBracketMatch.background': '#8be9fd50',
    'editorBracketMatch.border': '#8be9fd',
    
    // Indentation guides
    'editorIndentGuide.background': '#44475a',
    'editorIndentGuide.activeBackground': '#6272a4',
    
    // Scrollbar
    'scrollbarSlider.background': '#44475a75',
    'scrollbarSlider.hoverBackground': '#44475a',
    'scrollbarSlider.activeBackground': '#6272a4',
    
    // Minimap
    'minimap.background': '#282a36',
    
    // Suggestions/IntelliSense
    'editorSuggestWidget.background': '#282a36',
    'editorSuggestWidget.border': '#44475a',
    'editorSuggestWidget.foreground': '#f8f8f2',
    'editorSuggestWidget.selectedBackground': '#44475a',
    'editorSuggestWidget.highlightForeground': '#61dafb',
    
    // Hover widget
    'editorHoverWidget.background': '#282a36',
    'editorHoverWidget.border': '#44475a',
    'editorHoverWidget.foreground': '#f8f8f2',
    
    // Error/warning squiggles
    'editorError.foreground': '#ff5555',
    'editorWarning.foreground': '#ffb86c',
    'editorInfo.foreground': '#8be9fd',
  }
};

// Tema alternativo mais suave
export const toqueMediaSoftTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // Palavras-reservadas - Roxo suave
    { token: 'keyword', foreground: '#c4b5fd', fontStyle: 'bold' }, // Soft purple
    { token: 'keyword.control', foreground: '#a78bfa', fontStyle: 'bold' }, // Medium purple
    { token: 'keyword.operator', foreground: '#ddd6fe', fontStyle: 'bold' }, // Light purple
    
    // Strings - Verde mint
    { token: 'string', foreground: '#86efac' },
    { token: 'string.template', foreground: '#67e8f9' },
    
    // Números - Pêssego suave
    { token: 'number', foreground: '#fdba74' },
    
    // Funções - Amarelo suave
    { token: 'entity.name.function', foreground: '#fde047', fontStyle: 'bold' },
    
    // Tipos - Lavanda
    { token: 'type', foreground: '#c4b5fd', fontStyle: 'bold' },
    { token: 'entity.name.type', foreground: '#a78bfa' },
    
    // Constantes - Rosa suave
    { token: 'constant', foreground: '#f9a8d4', fontStyle: 'bold' },
    
    // Comentários
    { token: 'comment', foreground: '#94a3b8', fontStyle: 'italic' },
  ],
  colors: {
    'editor.background': '#1e2030', // Slate 900 (lighter)
    'editor.foreground': '#f1f5f9', // Slate 100
    'editor.lineHighlightBackground': '#1e293b50', // Slate 800 with opacity
    'editorLineNumber.foreground': '#64748b', // Slate 500
  }
};

export default toqueMediaTheme;