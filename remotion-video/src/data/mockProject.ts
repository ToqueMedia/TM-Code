// Mock project + brand copy for the focused Chat-Mode story.

export const SAAS_PROJECT = {
  name: 'startup-demo',
  path: '/Users/celio/projects/startup-demo',
  branch: 'main',
  lastCommit: 'e2a91f0 chore: init vite + react + ts',
} as const

/** Message 1 — the /plan request (chip-highlighted). */
export const GENERAL_PROMPT_TEXT =
  '/plan Cria uma landing page para a minha startup com login por email/password, dashboard e formulário de espera. #auth-email-password'

/** Message 7 — the #design iteration (chip-highlighted). */
export const DESIGN_PROMPT_TEXT = 'Melhora a UI/UX e deixa a página mais premium. #design'

/** The 3 micro title cards (between phases). */
export const TITLE_CARDS = {
  prompt: '1. Pede no Chat',
  approve: '2. Aprova e vê acontecer',
  publish: '3. Publica online',
} as const

/** Scene 1 — hook / central message. */
export const GENERAL_INTRO = {
  headline: 'Do pedido ao projecto online.',
  accent: 'Dentro do Chat.',
  sub: 'TM Code transforma pedidos em código, preview e deploy.',
} as const

/** Final CTA copy. */
export const GENERAL_BRANDING = {
  name: 'TM Code',
  headline: 'Do pedido ao projecto online. Dentro do Chat.',
  headlineLines: ['Do pedido ao projecto online.', 'Dentro do Chat.'],
  ctaPrefix: 'Começa grátis em',
  url: 'code.toquemedia.net',
} as const
