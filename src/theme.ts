// src/theme.ts
import { createSystem, defaultConfig } from '@chakra-ui/react'
import { tokens } from './theme/tokens'

const t = tokens.colors

export const theme = createSystem(defaultConfig, {
  globalCss: {
    'html, body': {
      backgroundColor: 'transparent',
      color: t.text.dimmed,
      fontFamily: tokens.fontFamily.ui,
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
    'input, textarea, [contenteditable="true"], .monaco-editor, .monaco-editor *, .xterm-rows, .xterm-viewport, .xterm-screen': {
      userSelect: 'text',
      WebkitUserSelect: 'text',
    },
    // Monaco context menu — cursor fix
    '.monaco-editor .monaco-menu, .monaco-editor .monaco-menu *': {
      cursor: 'default !important',
    },
    '.monaco-editor .monaco-menu .action-item': {
      cursor: 'pointer !important',
    },

    // Desktop-like cursor behavior in top bars
    '.vscode-titlebar button, .vscode-statusbar button, .vscode-tabs button, .vscode-titlebar [role="button"]': {
      cursor: 'default',
    },

    // Focus ring refinement
    'button:focus, [role="button"]:focus, a:focus, input:focus, textarea:focus': {
      outline: 'none !important',
    },
    'button:focus-visible, [role="button"]:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible': {
      outline: 'none',
      boxShadow: 'none',
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
      WebkitTextFillColor: t.text.primary,
      boxShadow: `0 0 0px 1000px ${t.bg.app} inset`,
      transition: 'background-color 9999s ease-in-out 0s',
    },

    // Custom scrollbars (WebKit)
    '::-webkit-scrollbar': {
      width: '10px',
      height: '10px',
    },
    '::-webkit-scrollbar-track': {
      background: t.scrollbar.track,
    },
    '::-webkit-scrollbar-thumb': {
      background: t.scrollbar.thumb,
      borderRadius: tokens.radius.scrollbar,
      border: '2px solid rgba(0,0,0,0)',
      backgroundClip: 'padding-box',
    },
    '::-webkit-scrollbar-thumb:hover': {
      background: t.scrollbar.thumbHover,
    },

    // Hide scrollbars within explorer viewport but allow scroll
    '.explorer-viewport::-webkit-scrollbar': {
      width: '0px',
      height: '0px',
    },

    // VS Code specific styling
    '.vscode-titlebar': {
      backgroundColor: '#323233',
      borderBottom: `1px solid ${t.border.subtle}`,
      cursor: 'pointer',
    },
    '.vscode-activitybar': {
      backgroundColor: t.bg.activitybar,
      borderRight: `1px solid ${t.border.subtle}`,
    },
    '.vscode-sidebar': {
      backgroundColor: t.bg.sidebar,
      borderRight: `1px solid ${t.border.subtle}`,
    },
    '.vscode-editor-area': {
      backgroundColor: t.bg.app,
    },
    '.vscode-tabs': {
      backgroundColor: t.bg.overlay,
      borderBottom: `1px solid ${t.border.subtle}`,
    },
    '.vscode-tab': {
      backgroundColor: t.bg.overlay,
      borderRight: `1px solid ${t.border.subtle}`,
      color: t.text.dimmed,
      '&.active': {
        backgroundColor: t.bg.app,
        color: t.text.inverse,
      },
    },
    '.vscode-bottom-panel': {
      backgroundColor: t.bg.sidebar,
      borderTop: `1px solid ${t.border.subtle}`,
    },
    '.vscode-statusbar': {
      backgroundColor: t.accent.blue,
      color: t.text.inverse,
    },
    // Ensure editor container maintains dark background
    '.monaco-editor-background': {
      backgroundColor: `${t.bg.app} !important`,
    },
    '.monaco-editor .margin': {
      backgroundColor: `${t.bg.app} !important`,
    },
    '.terminal, .xterm': {
      '& *': {
        color: 'inherit !important',
      },
    },
    // Menu and dropdown styling
    '[data-scope="menu"][data-part="content"]': {
      backgroundColor: `${t.menu.bg} !important`,
      color: 'white !important',
      borderColor: `${t.menu.border} !important`,
      backgroundImage: 'none !important',
    },
    '[data-scope="menu"][data-part="item"]': {
      color: 'white !important',
      backgroundImage: 'none !important',
      _hover: {
        backgroundColor: `${t.menu.hover} !important`,
        color: 'white !important',
        backgroundImage: 'none !important',
      },
    },
    // Dialog styling
    '[data-scope="dialog"][data-part="content"]': {
      backgroundColor: `${t.menu.bg} !important`,
      color: 'white !important',
      borderColor: `${t.menu.border} !important`,
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
        'bg': { value: t.bg.app },
        'fg': { value: '#cccccc' },
        'bg.muted': { value: t.bg.sidebar },
        'fg.muted': { value: t.text.dimmed },
        'bg.subtle': { value: t.bg.overlay },
        'fg.subtle': { value: t.text.subtle },
        'border': { value: t.border.subtle },
        'border.muted': { value: '#3e3e3e' },

        blue: {
          500: { value: t.accent.primary },
          solid: { value: t.accent.blueAlt },
          muted: { value: t.bg.selection },
          subtle: { value: t.accent.primarySubtle },
        },
        purple: { 500: { value: t.accent.purple } },
        green: {
          500: { value: t.accent.green },
          muted: { value: 'rgba(46, 160, 67, 0.4)' },
          subtle: { value: t.accent.greenSubtle },
        },
        orange: { 500: { value: t.accent.orange } },
        red: {
          500: { value: '#ff5555' },
          solid: { value: t.accent.red },
          muted: { value: 'rgba(248, 81, 73, 0.4)' },
          subtle: { value: t.accent.redSubtle },
        },
        yellow: { 500: { value: '#f1fa8c' } },
        pink: { 500: { value: '#ff79c6' } },
        cyan: { 500: { value: '#8be9fd' } },

        ide: {
          bg: {
            welcome: { value: t.bg.welcome },
            editor: { value: t.bg.app },
            glass: { value: t.bg.glass },
            sidebar: { value: t.bg.sidebar },
            overlay: { value: t.bg.overlay },
            terminal: { value: t.bg.terminal },
            status: { value: t.accent.blue },
            tabActive: { value: t.bg.app },
            tabInactive: { value: t.bg.overlay },
            tabHover: { value: '#37415A' },
          },
          text: {
            primary: { value: t.text.inverse },
            secondary: { value: 'rgba(255, 255, 255, 0.9)' },
            muted: { value: 'rgba(255, 255, 255, 0.7)' },
            link: { value: t.accent.primary },
          },
          border: {
            default: { value: t.border.default },
            glass: { value: t.border.glass },
            focus: { value: t.accent.primary },
            tab: { value: t.border.tab },
          },
          selection: { value: t.bg.selection },
          findMatch: { value: '#515c6a' },
          currentFindMatch: { value: '#613214' },
        }
      },
      fonts: {
        heading: { value: tokens.fontFamily.ui },
        body: { value: tokens.fontFamily.ui },
        mono: { value: tokens.fontFamily.mono },
      },
      radii: {
        sm: { value: tokens.radius.sm },
        md: { value: tokens.radius.md },
        lg: { value: tokens.radius.lg },
      },
      shadows: {
        'toolbar': { value: tokens.shadow.toolbar },
        'panel': { value: tokens.shadow.panel },
      }
    },
  },
})
