// Dedicated MOBILE vertical story (Stories/Reels/Status) — 1080x1920, 30fps,
// 45s. NOT a re-layout of the 16:9 timeline: discrete, punchy, big-text scenes
// optimized for fast silent consumption. Story: hook → pede → plano → código →
// #design (wow) → deploy → browser → CTA.

import type { DiffSpec } from './diffData'

export const SFPS = 30
export const SWIDTH = 1080
export const SHEIGHT = 1920

export interface SceneSlot {
  from: number
  duration: number
}

export const STORY = {
  hook: { from: 0, duration: 90 }, // 0–3s
  prompt: { from: 90, duration: 150 }, // 3–8s
  plan: { from: 240, duration: 150 }, // 8–13s
  build: { from: 390, duration: 210 }, // 13–20s
  design: { from: 600, duration: 270 }, // 20–29s
  deploy: { from: 870, duration: 210 }, // 29–36s
  browser: { from: 1080, duration: 150 }, // 36–41s
  cta: { from: 1230, duration: 120 }, // 41–45s
} as const satisfies Record<string, SceneSlot>

export const STORY_TOTAL = 1350 // 45s @ 30fps

export const HOOK = {
  question: 'Tens uma ideia?',
  answer: 'Cria o projecto pelo Chat.',
  brand: 'TM Code',
} as const

// Slightly shortened for mobile legibility (chips: /plan + #auth-email-password).
export const STORY_PROMPT =
  '/plan Cria uma landing page com login por email/password, dashboard e formulário de espera. #auth-email-password'

export const STORY_PLAN_ITEMS = [
  'Landing page',
  'Login email/password',
  'Dashboard',
  'Preview e deploy',
] as const

// Human build lines (no file names) — fast to read on mobile.
export const STORY_BUILD_LINES = [
  'Criou a página',
  'Adicionou login',
  'Preparou formulário',
  'Gerou o preview',
] as const

export const STORY_STEPS = ['Build completo', 'SSL pronto', 'Online'] as const

export const STORY_CAPTIONS = {
  prompt: 'Pede no Chat',
  plan: 'A IA planeia antes de criar',
  build: 'Tu aprovas o código',
  design: '#design transforma a interface',
  deploy: 'Publica num clique',
  online: 'O teu projecto online',
} as const

export const STORY_DESIGN_PROMPT = 'Melhora a UI/UX. #design'

// A short, big, mobile-legible diff (3 add lines).
export const STORY_DIFF: DiffSpec = {
  filePath: 'Hero.tsx',
  summary: 'Hero.tsx',
  lines: [
    { kind: 'hunk', text: 'Hero.tsx' },
    { kind: 'add', lineNo: 14, text: '<h1>Lança a tua ideia mais rápido</h1>' },
    { kind: 'add', lineNo: 15, text: '<WaitlistForm />' },
    { kind: 'add', lineNo: 16, text: '<EmailPasswordAuth />' },
  ],
}
export const STORY_DIFF_FOCUS = [1, 3] as const
