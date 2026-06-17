// Mock project + brand copy for the general promo. Deliberately distinct from
// the /te2e video's PROJECT (katondo-queue) so the two videos never bleed.

export const SAAS_PROJECT = {
  name: 'saas-demo',
  path: '/Users/celio/projects/saas-demo',
  branch: 'main',
  lastCommit: 'e2a91f0 chore: init vite + react + ts',
} as const

export const GENERAL_PROMPT_TEXT =
  'Cria uma landing page para o meu SaaS com login Google, dashboard e botão de waitlist.'

/** Discreet syntax hints shown under the prompt bar (slash / mention / opt-in). */
export const PROMPT_HINTS = ['/plan', '@ ficheiros', '#auth-google'] as const

export const PROJECT_FILES = [
  'src/App.tsx',
  'src/pages/Landing.tsx',
  'src/components/Hero.tsx',
  'src/components/DashboardPreview.tsx',
  'src/lib/auth.ts',
  'package.json',
] as const

// Files shown changed in the Source Control mock (scene 8).
export const CHANGED_FILES = [
  { path: 'src/components/Hero.tsx', status: 'M' as const },
  { path: 'src/pages/Landing.tsx', status: 'M' as const },
  { path: 'src/components/DashboardPreview.tsx', status: 'A' as const },
  { path: 'src/lib/auth.ts', status: 'A' as const },
] as const

export const GENERAL_BRANDING = {
  name: 'TM Code',
  tagline: 'A IDE onde o agente escreve o código por ti.',
  headline: 'Conversa. Vê programar. Publica.',
  sub: 'Grátis para começar.',
  cta: 'Descarrega o TM Code',
  url: 'code.toquemedia.net',
} as const

// Welcome-screen mode-card copy (scene 2). Mirrors the real product strings.
export const MODE_CARDS = {
  chat: {
    title: 'Chat Mode',
    badge: 'RECOMMENDED',
    line: 'From zero to live',
    desc: 'O agente planeia, escreve código e publica por ti.',
  },
  terminal: {
    title: 'Terminal Mode',
    badge: 'POWER USERS',
    line: 'Power users',
    desc: 'Qualquer stack, qualquer tarefa.',
  },
} as const
