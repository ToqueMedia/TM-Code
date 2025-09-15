// src/theme.ts
import { createSystem, defaultConfig } from '@chakra-ui/react'

export const theme = createSystem(defaultConfig, {
  theme: {
    tokens: {
      colors: {
        blue: { 500: { value: '#58a6ff' } },
        purple: { 500: { value: '#a371f7' } },
        green: { 500: { value: '#2ea043' } },
        orange: { 500: { value: '#f77f00' } },
        bg: {
          welcome: { value: '#0a0e13' },
          editor: { value: '#0d1117' },
          glass: { value: 'rgba(13, 17, 23, 0.8)' },
        },
        text: {
          primary: { value: '#e6edf3' },
          secondary: { value: '#8b949e' },
          muted: { value: '#7d8590' },
        },
        border: {
          default: { value: 'rgba(48, 54, 61, 0.8)' },
        },
      },
      fonts: {
        heading: { value: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif' },
        body: { value: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif' },
      },
    },
  },
})