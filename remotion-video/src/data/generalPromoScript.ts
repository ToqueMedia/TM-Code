// The agent conversation + tool calls shown across the general promo. Single
// source of truth so every scene tells the same "saas-demo" story.

import type { ToolCallSpec } from './agentScript'

export const GENERAL_MESSAGES = {
  plan: 'Vou planear a estrutura e configurar a autenticação com Google.',
  found: 'Encontrei o ponto de entrada. Vou criar a Hero, o dashboard e o fluxo de login.',
  building: 'A criar os componentes e a ligar o botão de waitlist.',
  done: 'Pronto. A tua landing já corre no preview e os testes passaram.',
} as const

// Tool verbs stay in English (they are part of the real product UI).
export const GENERAL_TOOL_CALLS = {
  readApp: { verbRunning: 'Reading', verbDone: 'Read', subtitle: 'src/App.tsx', summary: '64 lines' },
  searchAuth: { verbRunning: 'Searching', verbDone: 'Searched', subtitle: 'auth', summary: '5 results' },
  editHero: {
    verbRunning: 'Editing',
    verbDone: 'Edited',
    subtitle: 'src/components/Hero.tsx',
    summary: 'Added 16 lines',
  },
  editAuth: {
    verbRunning: 'Editing',
    verbDone: 'Edited',
    subtitle: 'src/lib/auth.ts',
    summary: 'Added 9 lines',
  },
  editLanding: {
    verbRunning: 'Editing',
    verbDone: 'Edited',
    subtitle: 'src/pages/Landing.tsx',
    summary: 'Added 22 lines',
  },
  runTests: { verbRunning: 'Running', verbDone: 'Ran', subtitle: 'npm test', summary: '✓ 4 passed' },
  verifyPreview: {
    verbRunning: 'Verifying',
    verbDone: 'Verified',
    subtitle: 'preview',
    summary: '✓ preview ok',
  },
} as const satisfies Record<string, ToolCallSpec>

export const REASONING = {
  label: 'A pensar',
  duration: '2.3s',
  lines: [
    'O utilizador quer uma landing com login Google, dashboard e waitlist.',
    'Plano: criar Hero + DashboardPreview, configurar auth.ts e ligar a waitlist.',
    'Depois corro os testes e abro o preview ao vivo.',
  ],
} as const

export const GENERAL_TEST = {
  command: 'npm test',
  checks: [
    'renders landing page',
    'opens Google login flow',
    'submits waitlist form',
    'dashboard preview is visible',
  ],
  summary: '4 passed (3.2s)',
} as const

export const COMMIT_MESSAGE = 'feat: add SaaS landing page and auth flow'

// Short overlay captions (PT). One message per scene.
export const CAPTIONS = {
  modes: 'Guiado ou liberdade total. Tu escolhes.',
  prompt: 'Descreve o que queres.',
  work: 'Planeia. Lê. Escreve.',
  diff: 'Aprovas cada mudança.',
  preview: 'Vê a tua app a correr. Na mesma janela.',
  deploy: 'Publica num clique.',
  powerTerminal: 'Terminal agêntico.',
  powerGit: 'Git com IA.',
  powerPerm: 'Tu autorizas tudo.',
} as const
