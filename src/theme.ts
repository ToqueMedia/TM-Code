// src/theme.ts
import { createSystem, defaultConfig } from '@chakra-ui/react'

export const theme = createSystem(defaultConfig, {
  globalCss: {
    'html, body': {
      backgroundColor: 'transparent',
      color: '#cccccc',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      overscrollBehavior: 'none',
      overflow: 'hidden',
      margin: 0,
      padding: 0,
    },
    '#root, body > div': {
      userSelect: 'none',
      WebkitUserSelect: 'none',
    },
    '*': {
      boxSizing: 'border-box',
      WebkitTapHighlightColor: 'transparent',
    },
    // Allow selection where needed
    'input, textarea, [contenteditable="true"], .monaco-editor, .xterm-rows, .xterm-viewport, .xterm-screen': {
      userSelect: 'text',
      WebkitUserSelect: 'text',
    },

    // Desktop-like cursor behavior in top bars
    '.vscode-titlebar button, .vscode-statusbar button, .vscode-tabs button, .vscode-titlebar [role="button"]': {
      cursor: 'default',
    },

    // Focus ring refinement (remove default outline and add subtle ring on focus-visible)
    'button:focus, [role="button"]:focus, a:focus, input:focus, textarea:focus': {
      outline: 'none !important',
    },
    'button:focus-visible, [role="button"]:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible': {
      outline: 'none',
      boxShadow: '0 0 0 2px rgba(88, 166, 255, 0.4)',
    },

    // Search field anti-autocomplete and autofill tweaks
'input': {
      backgroundImage: 'none',
      WebkitAppearance: 'none',
    },
    'input::-webkit-search-decoration, input::-webkit-search-cancel-button, input::-webkit-search-results-button, input::-webkit-search-results-decoration': {
      display: 'none',
    },
    'input::-webkit-contacts-auto-fill-button': { display: 'none' },
'input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus': {
      WebkitTextFillColor: '#e6edf3',
      boxShadow: '0 0 0px 1000px #1e1e1e inset',
      transition: 'background-color 9999s ease-in-out 0s',
    },

    // Custom scrollbars (WebKit)
    '::-webkit-scrollbar': {
      width: '10px',
      height: '10px',
    },
    '::-webkit-scrollbar-track': {
      background: 'transparent',
    },
    '::-webkit-scrollbar-thumb': {
      background: '#3c3c3c',
      borderRadius: '8px',
      border: '2px solid rgba(0,0,0,0)',
      backgroundClip: 'padding-box',
    },
    '::-webkit-scrollbar-thumb:hover': {
      background: '#4a4a4a',
    },

    // Hide scrollbars within explorer viewport but allow scroll
    '.explorer-viewport::-webkit-scrollbar': {
      width: '0px',
      height: '0px',
    },

    // Tauri drag regions (handled via data-tauri-drag-region + programmatic startDragging)
    // VS Code specific styling
    '.vscode-titlebar': {
      backgroundColor: '#323233',
      borderBottom: '1px solid #2b2b2c',
      cursor: 'pointer',
    },
    '.vscode-activitybar': {
      backgroundColor: '#333333',
      borderRight: '1px solid #2b2b2c',
    },
    '.vscode-sidebar': {
      backgroundColor: '#252526',
      borderRight: '1px solid #2b2b2c',
    },
    '.vscode-editor-area': {
      backgroundColor: '#1e1e1e',
    },
    '.vscode-tabs': {
      backgroundColor: '#2d2d30',
      borderBottom: '1px solid #2b2b2c',
    },
    '.vscode-tab': {
      backgroundColor: '#2d2d30',
      borderRight: '1px solid #2b2b2c',
      color: '#969696',
      '&.active': {
        backgroundColor: '#1e1e1e',
        color: '#ffffff',
      },
    },
    '.vscode-bottom-panel': {
      backgroundColor: '#252526',
      borderTop: '1px solid #2b2b2c',
    },
    '.vscode-statusbar': {
      backgroundColor: '#007acc',
      color: '#ffffff',
    },
    // Ensure editor container maintains dark background
    '.monaco-editor-background': {
      backgroundColor: '#1e1e1e !important',
    },
    '.monaco-editor .margin': {
      backgroundColor: '#1e1e1e !important',
    },
    '.terminal, .xterm': {
      '& *': {
        color: 'inherit !important',
      },
    },
    // Menu and dropdown styling
    '[data-scope="menu"][data-part="content"]': {
      backgroundColor: '#2d2d30 !important',
      color: 'white !important',
      borderColor: '#3c3c3c !important',
      backgroundImage: 'none !important',
    },
    '[data-scope="menu"][data-part="item"]': {
      color: 'white !important',
      backgroundImage: 'none !important',
      _hover: {
        backgroundColor: '#094771 !important',
        color: 'white !important',
        backgroundImage: 'none !important',
      },
    },
    // Dialog styling
    '[data-scope="dialog"][data-part="content"]': {
      backgroundColor: '#2d2d30 !important',
      color: 'white !important',
      borderColor: '#3c3c3c !important',
      backgroundImage: 'none !important',
    },
    // Button styling
    'button': {
      color: 'white !important',
      backgroundImage: 'none !important',
    },
    // Alert styling
    '[data-scope="alert"]': {
      color: 'white !important',
      backgroundImage: 'none !important',
    },
  },
  theme: {
    tokens: {
      colors: {
        // VS Code theme colors
        'bg': { value: '#1e1e1e' },
        'fg': { value: '#cccccc' },
        'bg.muted': { value: '#252526' },
        'fg.muted': { value: '#969696' },
        'bg.subtle': { value: '#2d2d30' },
        'fg.subtle': { value: '#858585' },
        'border': { value: '#2b2b2c' },
        'border.muted': { value: '#3e3e3e' },
        
        // Syntax highlighting colors
        blue: { 
          500: { value: '#58a6ff' },
          solid: { value: '#0078d4' },
          muted: { value: '#264f78' },
          subtle: { value: 'rgba(88, 166, 255, 0.1)' },
        },
        purple: { 500: { value: '#a371f7' } },
        green: { 
          500: { value: '#2ea043' },
          muted: { value: 'rgba(46, 160, 67, 0.4)' },
          subtle: { value: 'rgba(46, 160, 67, 0.1)' },
        },
        orange: { 500: { value: '#f77f00' } },
        red: { 
          500: { value: '#ff5555' },
          solid: { value: '#f85149' },
          muted: { value: 'rgba(248, 81, 73, 0.4)' },
          subtle: { value: 'rgba(248, 81, 73, 0.1)' },
        },
        yellow: { 500: { value: '#f1fa8c' } },
        pink: { 500: { value: '#ff79c6' } },
        cyan: { 500: { value: '#8be9fd' } },
        
        // IDE-specific colors
        ide: {
          bg: {
            welcome: { value: '#0a0e13' },
            editor: { value: '#1e1e1e' },
            glass: { value: 'rgba(30, 30, 30, 0.9)' },
            sidebar: { value: '#252526' },
            overlay: { value: '#2d2d30' },
            terminal: { value: '#1e1e1e' },
            status: { value: '#007acc' },
            tabActive: { value: '#1e1e1e' },
            tabInactive: { value: '#2d2d30' },
            tabHover: { value: '#37415A' },
          },
          text: {
            primary: { value: 'white' },
            secondary: { value: 'rgba(255, 255, 255, 0.9)' },
            muted: { value: 'rgba(255, 255, 255, 0.7)' },
            link: { value: '#58a6ff' },
          },
          border: {
            default: { value: '#3c3c3c' },
            glass: { value: 'rgba(56, 56, 56, 0.6)' },
            focus: { value: '#007fd4' },
            tab: { value: '#252526' },
          },
          selection: { value: '#264f78' },
          findMatch: { value: '#515c6a' },
          currentFindMatch: { value: '#613214' },
        }
      },
      fonts: {
        heading: { value: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif' },
        body: { value: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif' },
        mono: { value: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace' },
      },
      radii: {
        sm: { value: '2px' },
        md: { value: '4px' },
        lg: { value: '6px' },
      },
      shadows: {
        'toolbar': { value: '0 1px 3px rgba(0, 0, 0, 0.3)' },
        'panel': { value: '0 2px 8px rgba(0, 0, 0, 0.4)' },
      }
    },
  },
})