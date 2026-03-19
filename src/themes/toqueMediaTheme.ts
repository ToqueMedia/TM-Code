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
    // Editor background — matches app bg for seamless look
    'editor.background': '#0f0f0f',
    'editor.foreground': '#e6edf3',

    // Gutter / line numbers
    'editorLineNumber.foreground': '#3d4450',
    'editorLineNumber.activeForeground': '#8b949e',
    'editorGutter.background': '#0f0f0f',
    'editorGutter.addedBackground': '#2ea04380',
    'editorGutter.modifiedBackground': '#a371f780',
    'editorGutter.deletedBackground': '#f8514980',

    // Cursor
    'editorCursor.foreground': '#FE1063',

    // Selection
    'editor.selectionBackground': '#FE106330',
    'editor.selectionHighlightBackground': '#FE106318',
    'editor.inactiveSelectionBackground': '#FE106315',

    // Word highlight
    'editor.wordHighlightBackground': '#a371f720',
    'editor.wordHighlightStrongBackground': '#a371f730',

    // Find/search
    'editor.findMatchBackground': '#FE106340',
    'editor.findMatchHighlightBackground': '#FE106320',
    'editor.findMatchBorder': '#FE1063',

    // Current line
    'editor.lineHighlightBackground': '#ffffff06',
    'editor.lineHighlightBorder': '#00000000',

    // Brackets
    'editorBracketMatch.background': '#a371f730',
    'editorBracketMatch.border': '#a371f7',
    'editorBracketHighlight.foreground1': '#FE1063',
    'editorBracketHighlight.foreground2': '#a371f7',
    'editorBracketHighlight.foreground3': '#50fa7b',
    'editorBracketHighlight.foreground4': '#ffd166',
    'editorBracketHighlight.foreground5': '#61dafb',
    'editorBracketHighlight.foreground6': '#ff79c6',

    // Indentation guides
    'editorIndentGuide.background': '#ffffff08',
    'editorIndentGuide.activeBackground': '#ffffff18',

    // Scrollbar — thin, subtle
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#ffffff12',
    'scrollbarSlider.hoverBackground': '#ffffff20',
    'scrollbarSlider.activeBackground': '#ffffff30',

    // Minimap
    'minimap.background': '#0a0a0a',
    'minimap.selectionHighlight': '#FE106340',
    'minimap.findMatchHighlight': '#FE106360',
    'minimapSlider.background': '#ffffff10',
    'minimapSlider.hoverBackground': '#ffffff18',
    'minimapSlider.activeBackground': '#ffffff25',
    'minimapGutter.addedBackground': '#2ea04380',
    'minimapGutter.modifiedBackground': '#a371f780',
    'minimapGutter.deletedBackground': '#f8514980',

    // Overview ruler (right edge)
    'editorOverviewRuler.background': '#0a0a0a',
    'editorOverviewRuler.border': '#00000000',
    'editorOverviewRuler.addedForeground': '#2ea04380',
    'editorOverviewRuler.modifiedForeground': '#a371f780',
    'editorOverviewRuler.deletedForeground': '#f8514980',
    'editorOverviewRuler.errorForeground': '#f85149',
    'editorOverviewRuler.warningForeground': '#f77f00',

    // Suggestions/IntelliSense
    'editorSuggestWidget.background': '#161616',
    'editorSuggestWidget.border': '#262626',
    'editorSuggestWidget.foreground': '#e6edf3',
    'editorSuggestWidget.selectedBackground': '#FE106320',
    'editorSuggestWidget.selectedForeground': '#ffffff',
    'editorSuggestWidget.highlightForeground': '#FE1063',
    'editorSuggestWidget.focusHighlightForeground': '#FE1063',

    // Hover widget
    'editorHoverWidget.background': '#161616',
    'editorHoverWidget.border': '#262626',
    'editorHoverWidget.foreground': '#e6edf3',
    'editorHoverWidget.statusBarBackground': '#111111',

    // Error/warning squiggles
    'editorError.foreground': '#f85149',
    'editorWarning.foreground': '#f77f00',
    'editorInfo.foreground': '#61dafb',

    // Widget (find/replace bar)
    'editorWidget.background': '#161616',
    'editorWidget.border': '#262626',
    'editorWidget.foreground': '#e6edf3',

    // Folding
    'editor.foldBackground': '#ffffff06',

    // Whitespace
    'editorWhitespace.foreground': '#ffffff12',

    // Code lens
    'editorCodeLens.foreground': '#3d4450',

    // Peek view
    'peekView.border': '#FE106350',
    'peekViewEditor.background': '#111111',
    'peekViewResult.background': '#0f0f0f',
    'peekViewTitle.background': '#161616',
    'peekViewResult.matchHighlightBackground': '#FE106330',
    'peekViewEditor.matchHighlightBackground': '#FE106330',
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
    'editor.background': '#131313',
    'editor.foreground': '#f1f5f9',
    'editor.lineHighlightBackground': '#ffffff06',
    'editorLineNumber.foreground': '#3d4450',
    'editorLineNumber.activeForeground': '#8b949e',
    'editorCursor.foreground': '#a371f7',
    'editor.selectionBackground': '#a371f728',
    'scrollbarSlider.background': '#ffffff12',
    'scrollbarSlider.hoverBackground': '#ffffff20',
    'minimap.background': '#0f0f0f',
  }
};

export default toqueMediaTheme;