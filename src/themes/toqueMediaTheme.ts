import type { editor } from 'monaco-editor';

// ToqueMedia Studio Custom Theme - Cores vibrantes e modernas
export const toqueMediaTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // ═══ TM Code Theme — VS Code Dark+ inspired, brand pink keywords ═══

    // Keywords — brand pink (#c2185b)
    // import, export, const, let, var, function, class, return, if, else, try, catch, async, await, from, new, throw
    { token: 'keyword', foreground: '#c2185b' },
    { token: 'keyword.control', foreground: '#c2185b' },
    { token: 'keyword.operator', foreground: '#c2185b' },
    { token: 'keyword.other', foreground: '#c2185b' },
    { token: 'keyword.control.flow', foreground: '#c2185b' },
    { token: 'keyword.js', foreground: '#c2185b' },
    { token: 'keyword.ts', foreground: '#c2185b' },
    { token: 'keyword.control.js', foreground: '#c2185b' },
    { token: 'keyword.control.ts', foreground: '#c2185b' },
    { token: 'keyword.typescript', foreground: '#c2185b' },
    { token: 'keyword.javascript', foreground: '#c2185b' },
    { token: 'keyword.control.import.ts', foreground: '#c2185b' },
    { token: 'keyword.control.export.ts', foreground: '#c2185b' },
    { token: 'storage.type', foreground: '#c2185b' },
    { token: 'storage.modifier', foreground: '#c2185b' },
    { token: 'storage.type.ts', foreground: '#c2185b' },
    { token: 'storage.type.js', foreground: '#c2185b' },
    { token: 'storage.type.function.ts', foreground: '#c2185b' },
    { token: 'storage.type.function.js', foreground: '#c2185b' },

    // Types & classes — teal (#4ec9b0) like VS Code
    // Request, Response, Promise, void, string, number, boolean, interface, type, enum
    { token: 'type', foreground: '#4ec9b0' },
    { token: 'type.identifier', foreground: '#4ec9b0' },
    { token: 'type.identifier.ts', foreground: '#4ec9b0' },
    { token: 'type.identifier.tsx', foreground: '#4ec9b0' },
    { token: 'type.typescript', foreground: '#4ec9b0' },
    { token: 'entity.name.type', foreground: '#4ec9b0' },
    { token: 'entity.name.class', foreground: '#4ec9b0' },
    { token: 'entity.name.namespace', foreground: '#4ec9b0' },
    { token: 'support.type', foreground: '#4ec9b0' },
    { token: 'interface.typescript', foreground: '#4ec9b0' },
    { token: 'variable.other.enummember', foreground: '#4ec9b0' },

    // Functions — soft yellow (#dcdcaa) like VS Code
    // handleGenerateCodeConverter, generateContent, json, status
    { token: 'entity.name.function', foreground: '#dcdcaa' },
    { token: 'support.function', foreground: '#dcdcaa' },
    { token: 'meta.function-call', foreground: '#dcdcaa' },
    { token: 'function', foreground: '#dcdcaa' },
    { token: 'function.call', foreground: '#dcdcaa' },

    // Variables & parameters — light blue (#9cdcfe) like VS Code
    { token: 'variable', foreground: '#9cdcfe' },
    { token: 'variable.parameter', foreground: '#9cdcfe' },
    { token: 'variable.other', foreground: '#9cdcfe' },
    { token: 'variable.shell', foreground: '#9cdcfe' },

    // Identifiers — light blue (tags + attributes + variables all use this in TS mode)
    { token: 'identifier', foreground: '#9cdcfe' },
    { token: 'identifier.js', foreground: '#9cdcfe' },
    { token: 'identifier.ts', foreground: '#9cdcfe' },

    // this — pink italic
    { token: 'variable.language.this.js', foreground: '#c2185b', fontStyle: 'italic' },
    { token: 'this.javascript', foreground: '#c2185b', fontStyle: 'italic' },

    // Properties — light blue (#9cdcfe)
    // .body, .text, .systemInstruction, .temperature
    { token: 'variable.property', foreground: '#9cdcfe' },
    { token: 'property', foreground: '#9cdcfe' },
    { token: 'member', foreground: '#9cdcfe' },

    // Strings — warm salmon (#ce9178) like VS Code
    // "express", "./config/genAi", 'Erro ao converter código'
    { token: 'string', foreground: '#ce9178' },
    { token: 'string.quoted', foreground: '#ce9178' },
    { token: 'string.template', foreground: '#ce9178' },
    { token: 'string.escape', foreground: '#d7ba7d' },

    // Numbers — light green (#b5cea8) like VS Code
    // 0.1, 0.3, 1, 500
    { token: 'number', foreground: '#b5cea8' },
    { token: 'number.hex', foreground: '#b5cea8' },
    { token: 'number.binary', foreground: '#b5cea8' },
    { token: 'constant.numeric', foreground: '#b5cea8' },

    // Comments — green (#6a9955) like VS Code
    { token: 'comment', foreground: '#6a9955', fontStyle: 'italic' },
    { token: 'comment.line', foreground: '#6a9955', fontStyle: 'italic' },
    { token: 'comment.block', foreground: '#6a9955', fontStyle: 'italic' },

    // Constants — pink
    { token: 'constant', foreground: '#c2185b' },
    { token: 'constant.language', foreground: '#c2185b' },

    // Operators & delimiters
    { token: 'operator', foreground: '#d4d4d4' },
    { token: 'operator.ts', foreground: '#d4d4d4' },
    { token: 'delimiter', foreground: '#d4d4d4' },
    { token: 'delimiter.ts', foreground: '#d4d4d4' },
    { token: 'delimiter.bracket.ts', foreground: '#ffd700' },
    { token: 'delimiter.parenthesis.ts', foreground: '#d4d4d4' },
    { token: 'delimiter.square.ts', foreground: '#d4d4d4' },
    { token: 'delimiter.angle.ts', foreground: '#808080' },
    { token: 'punctuation', foreground: '#d4d4d4' },
    { token: 'delimiter.bracket.embed', foreground: '#c2185b' },

    // TS-specific tokens (actual Monaco tokenizer output)
    { token: 'string.ts', foreground: '#ce9178' },
    { token: 'number.ts', foreground: '#b5cea8' },
    { token: 'keyword.ts', foreground: '#c2185b' },
    { token: 'comment.ts', foreground: '#6a9955', fontStyle: 'italic' },
    { token: 'type.ts', foreground: '#4ec9b0' },
    { token: 'regexp.ts', foreground: '#d16969' },

    // Tags HTML/JSX — blue for tags, light blue for attributes
    { token: 'tag', foreground: '#569cd6' },
    { token: 'tag.ts', foreground: '#569cd6' },
    { token: 'tag.tsx', foreground: '#569cd6' },
    { token: 'tag.js', foreground: '#569cd6' },
    { token: 'tag.jsx', foreground: '#569cd6' },
    { token: 'tag.html', foreground: '#569cd6' },
    { token: 'tag.name', foreground: '#4ec9b0' },
    { token: 'metatag', foreground: '#569cd6' },
    { token: 'metatag.ts', foreground: '#569cd6' },
    { token: 'metatag.html', foreground: '#569cd6' },
    { token: 'delimiter.html', foreground: '#808080' },
    { token: 'delimiter.html.ts', foreground: '#808080' },
    { token: 'delimiter.html.tsx', foreground: '#808080' },
    { token: 'delimiter.html.js', foreground: '#808080' },
    { token: 'tag.attribute.name', foreground: '#9cdcfe' },
    { token: 'tag.attribute.value', foreground: '#ce9178' },
    { token: 'attribute.name.html', foreground: '#9cdcfe' },
    { token: 'attribute.name.html.ts', foreground: '#9cdcfe' },
    { token: 'attribute.value.html', foreground: '#ce9178' },
    { token: 'attribute.value.html.ts', foreground: '#ce9178' },

    // CSS
    { token: 'attribute.name.css', foreground: '#9cdcfe' },
    { token: 'attribute.value.css', foreground: '#ce9178' },
    { token: 'attribute.value.unit.css', foreground: '#b5cea8' },
    { token: 'attribute.value.number.css', foreground: '#b5cea8' },
    { token: 'property.css', foreground: '#9cdcfe' },
    { token: 'value.css', foreground: '#ce9178' },
    { token: 'tag.css', foreground: '#d7ba7d' },

    // JSON
    { token: 'key.json', foreground: '#9cdcfe' },
    { token: 'value.json', foreground: '#ce9178' },

    // Regex
    { token: 'regexp', foreground: '#d16969' },
    { token: 'regexp.escape', foreground: '#d7ba7d' },

    // Decorator
    { token: 'annotation', foreground: '#dcdcaa' },

    // YAML
    { token: 'type.yaml', foreground: '#9cdcfe' },
    { token: 'string.yaml', foreground: '#ce9178' },
    { token: 'number.yaml', foreground: '#b5cea8' },
    { token: 'keyword.yaml', foreground: '#c2185b' },

    // Shell
    { token: 'keyword.shell', foreground: '#c2185b' },

    // Markdown
    { token: 'emphasis.markdown', foreground: '#e6edf3', fontStyle: 'italic' },
    { token: 'strong.markdown', foreground: '#e6edf3', fontStyle: 'bold' },
    { token: 'heading.markdown', foreground: '#c2185b', fontStyle: 'bold' },
    { token: 'string.link.markdown', foreground: '#9cdcfe' },
    { token: 'markup.list.markdown', foreground: '#c2185b' },
    { token: 'markup.quote.markdown', foreground: '#6a9955', fontStyle: 'italic' },

    // Errors
    { token: 'invalid', foreground: '#f85149' },
    { token: 'invalid.deprecated', foreground: '#d7ba7d' },
  ],
  colors: {
    // Editor background — matches app bg for seamless look
    'editor.background': '#0f0f0f',
    'editor.foreground': '#e6edf3',

    // Definition link (Cmd+hover)
    'editorLink.activeForeground': '#60a5fa',

    // Gutter / line numbers
    'editorLineNumber.foreground': '#3d4450',
    'editorLineNumber.activeForeground': '#8b949e',
    'editorGutter.background': '#0f0f0f',
    'editorGutter.addedBackground': '#2ea04380',
    'editorGutter.modifiedBackground': '#a371f780',
    'editorGutter.deletedBackground': '#f8514980',

    // Cursor
    'editorCursor.foreground': '#c2185b',

    // Selection
    'editor.selectionBackground': '#c2185b30',
    'editor.selectionHighlightBackground': '#c2185b18',
    'editor.inactiveSelectionBackground': '#c2185b15',

    // Word highlight
    'editor.wordHighlightBackground': '#a371f720',
    'editor.wordHighlightStrongBackground': '#a371f730',

    // Find/search
    'editor.findMatchBackground': '#c2185b40',
    'editor.findMatchHighlightBackground': '#c2185b20',
    'editor.findMatchBorder': '#c2185b',

    // Current line
    'editor.lineHighlightBackground': '#ffffff06',
    'editor.lineHighlightBorder': '#00000000',

    // Brackets
    'editorBracketMatch.background': '#a371f730',
    'editorBracketMatch.border': '#a371f7',
    'editorBracketHighlight.foreground1': '#c2185b',
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
    'minimap.selectionHighlight': '#c2185b40',
    'minimap.findMatchHighlight': '#c2185b60',
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
    'editorSuggestWidget.selectedBackground': '#c2185b20',
    'editorSuggestWidget.selectedForeground': '#ffffff',
    'editorSuggestWidget.highlightForeground': '#c2185b',
    'editorSuggestWidget.focusHighlightForeground': '#c2185b',

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
    'peekView.border': '#c2185b50',
    'peekViewEditor.background': '#111111',
    'peekViewResult.background': '#0f0f0f',
    'peekViewTitle.background': '#161616',
    'peekViewResult.matchHighlightBackground': '#c2185b30',
    'peekViewEditor.matchHighlightBackground': '#c2185b30',

    // Sticky scroll
    'editorStickyScroll.background': '#0f0f0f',
    'editorStickyScrollHover.background': '#161616',

    // Inlay hints (type annotations, parameter names)
    'editorInlayHint.foreground': '#5c6370',
    'editorInlayHint.background': '#ffffff08',
    'editorInlayHint.typeForeground': '#5c6370',
    'editorInlayHint.typeBackground': '#ffffff06',
    'editorInlayHint.parameterForeground': '#5c6370',
    'editorInlayHint.parameterBackground': '#ffffff06',

    // Parameter hints widget
    'editorParameterHint.background': '#161616',
    'editorParameterHint.border': '#262626',
    'editorParameterHint.foreground': '#e6edf3',

    // Input fields (rename input, find input, etc.)
    'input.background': '#1a1a1a',
    'input.foreground': '#e6edf3',
    'input.border': '#333333',
    'input.placeholderForeground': '#5c6370',
    'inputOption.activeBackground': '#c2185b30',
    'inputOption.activeBorder': '#c2185b',
    'inputOption.activeForeground': '#e6edf3',
    'inputValidation.errorBackground': '#1a1a1a',
    'inputValidation.errorBorder': '#f85149',
    'inputValidation.warningBackground': '#1a1a1a',
    'inputValidation.warningBorder': '#f77f00',
    'inputValidation.infoBackground': '#1a1a1a',
    'inputValidation.infoBorder': '#61dafb',
    'focusBorder': '#c2185b80',

    // Linked editing (rename tag pairs)
    'editor.linkedEditingBackground': '#c2185b15',

    // Ghost text (inline suggestions)
    'editorGhostText.foreground': '#3d4450',

    // Menu / context menu
    'menu.background': '#161616',
    'menu.foreground': '#e6edf3',
    'menu.selectionBackground': '#c2185b20',
    'menu.selectionForeground': '#ffffff',
    'menu.separatorBackground': '#262626',
    'menu.border': '#262626',

    // Glyph margin (breakpoints, etc.)
    'editorGutter.foldingControlForeground': '#3d4450',

    // Breadcrumb
    'breadcrumb.foreground': '#8b949e',
    'breadcrumb.background': '#0f0f0f',
    'breadcrumb.focusForeground': '#e6edf3',
    'breadcrumb.activeSelectionForeground': '#e6edf3',

    // List/Tree
    'list.activeSelectionBackground': '#c2185b20',
    'list.activeSelectionForeground': '#ffffff',
    'list.hoverBackground': '#ffffff06',
    'list.inactiveSelectionBackground': '#ffffff08',
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
    'editorLink.activeForeground': '#60a5fa',
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