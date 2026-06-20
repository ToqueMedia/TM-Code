// Assistant messages, tool calls (build + design), plan items and small overlay
// text for the focused Chat-Mode story.

import type { ToolCallSpec } from './agentScript'

export const GENERAL_MESSAGES = {
  plan: 'Vou criar a estrutura da landing page, adicionar autenticação por email/password, preparar o dashboard e ligar o formulário de espera.',
  diffIntro: 'Aqui está a alteração ao `Hero.tsx` — revê e aprova:',
  applied: 'Alterações aplicadas. Estou a actualizar o preview.',
  designIntro: 'Vou polir o layout, melhorar espaçamento, contraste, CTA e secção de benefícios.',
  designDone: 'UI/UX polida. A nova versão já está no preview.',
} as const

// Tool verbs stay English (real UI); human labels (PT) are attached per chat entry.
export const GENERAL_TOOL_CALLS = {
  createLanding: { verbRunning: 'Creating', verbDone: 'Created', subtitle: 'src/pages/Landing.tsx', summary: '' },
  editHero: { verbRunning: 'Editing', verbDone: 'Edited', subtitle: 'src/components/Hero.tsx', summary: '' },
  editAuth: { verbRunning: 'Editing', verbDone: 'Edited', subtitle: 'src/lib/auth.ts', summary: '' },
  editWaitlist: { verbRunning: 'Editing', verbDone: 'Edited', subtitle: 'src/components/WaitlistForm.tsx', summary: '' },
  editHeroDesign: { verbRunning: 'Editing', verbDone: 'Edited', subtitle: 'src/components/Hero.tsx', summary: '' },
  editBenefits: { verbRunning: 'Editing', verbDone: 'Edited', subtitle: 'src/components/Benefits.tsx', summary: '' },
  editTheme: { verbRunning: 'Editing', verbDone: 'Edited', subtitle: 'src/styles/theme.css', summary: '' },
  editDashboard: { verbRunning: 'Editing', verbDone: 'Edited', subtitle: 'src/components/DashboardPreview.tsx', summary: '' },
} as const satisfies Record<string, ToolCallSpec>

/** PlanApprovalCard checklist. */
export const PLAN_ITEMS = [
  'Landing page',
  'Autenticação email/password',
  'Dashboard inicial',
  'Formulário de espera',
  'Preview e deploy',
] as const

/** Small overlay text (badges / browser caption). */
export const OVERLAY_TEXT = {
  previewBadge: 'Preview actualizado em tempo real',
  designBadge: 'UI/UX polida com #design',
  online: 'O teu projecto online.',
} as const
