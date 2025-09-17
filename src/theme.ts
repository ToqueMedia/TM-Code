// src/theme.ts
import { createSystem, defaultConfig } from '@chakra-ui/react'

export const theme = createSystem(defaultConfig, {
  theme: {
    tokens: {
      colors: {
        // Syntax highlighting colors
        blue: { 500: { value: '#58a6ff' } },
        purple: { 500: { value: '#a371f7' } },
        green: { 500: { value: '#2ea043' } },
        orange: { 500: { value: '#f77f00' } },
        red: { 500: { value: '#ff5555' } },
        yellow: { 500: { value: '#f1fa8c' } },
        pink: { 500: { value: '#ff79c6' } },
        cyan: { 500: { value: '#8be9fd' } },
        
        // IDE-specific colors
        bg: {
          welcome: { value: '#0a0e13' },
          editor: { value: '#1e1e1e' }, // Darker editor background
          glass: { value: 'rgba(30, 30, 30, 0.9)' },
          sidebar: { value: '#252526' }, // Slightly lighter sidebar
          overlay: { value: '#2d2d30' },
          terminal: { value: '#1e1e1e' }, // Match editor background
          status: { value: '#007acc' }, // VS Code-like status bar
        },
        text: {
          primary: { value: '#e6edf3' },
          secondary: { value: '#cccccc' }, // Lighter secondary text
          muted: { value: '#999999' },
          link: { value: '#3794ff' },
        },
        border: {
          default: { value: '#3c3c3c' },
          glass: { value: 'rgba(56, 56, 56, 0.6)' },
          focus: { value: '#007fd4' },
        },
        
        // IDE-specific semantic colors
        ide: {
          activeTab: { value: '#1e1e1e' },
          inactiveTab: { value: '#2d2d30' },
          tabBorder: { value: '#252526' },
          buttonHover: { value: '#4b4b4d' },
          buttonActive: { value: '#094771' },
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