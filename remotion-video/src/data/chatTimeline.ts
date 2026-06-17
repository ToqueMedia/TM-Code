// THE single, persistent Chat-Mode timeline. One accumulating conversation for
// the whole video — messages are never recreated or reset per scene; each entry
// just appears (and stays) when its session-local startFrame passes. The
// SessionScene renders this once; "scenes"/cards/cursors are overlays on top.
//
// All frames here are LOCAL to the session sequence (global = frame + SESSION_FROM).

import { DESIGN_PROMPT_TEXT, GENERAL_PROMPT_TEXT } from './mockProject'
import { GENERAL_MESSAGES, GENERAL_TOOL_CALLS } from './generalPromoScript'
import type { ToolCallSpec } from './agentScript'

export interface ToolItem {
  spec: ToolCallSpec
  startFrame: number
  doneFrame: number
  human: string
}

export type ChatEntry =
  | { id: string; kind: 'user'; startFrame: number; text: string; chips: boolean }
  | { id: string; kind: 'assistant'; startFrame: number; text: string }
  | { id: string; kind: 'plan'; startFrame: number; approvePressFrame: number; approvedFrame: number }
  | { id: string; kind: 'tools'; startFrame: number; items: ToolItem[] }
  | {
      id: string
      kind: 'diff'
      startFrame: number
      approveAppearFrame: number
      approvePressFrame: number
      approvedFrame: number
    }

const T = GENERAL_TOOL_CALLS

export const CHAT_TIMELINE: ChatEntry[] = [
  { id: 'm1', kind: 'user', startFrame: 24, text: GENERAL_PROMPT_TEXT, chips: true },
  { id: 'm2', kind: 'assistant', startFrame: 150, text: GENERAL_MESSAGES.plan },
  { id: 'm3', kind: 'plan', startFrame: 270, approvePressFrame: 360, approvedFrame: 370 },
  {
    id: 'm4',
    kind: 'tools',
    startFrame: 396,
    items: [
      { spec: T.createLanding, startFrame: 396, doneFrame: 414, human: 'Criou a página' },
      { spec: T.editHero, startFrame: 414, doneFrame: 432, human: 'Montou o hero' },
      { spec: T.editAuth, startFrame: 432, doneFrame: 450, human: 'Ligou autenticação' },
      { spec: T.editWaitlist, startFrame: 450, doneFrame: 468, human: 'Preparou formulário' },
    ],
  },
  { id: 'm5', kind: 'assistant', startFrame: 486, text: GENERAL_MESSAGES.diffIntro },
  { id: 'm5d', kind: 'diff', startFrame: 506, approveAppearFrame: 578, approvePressFrame: 650, approvedFrame: 660 },
  { id: 'm6', kind: 'assistant', startFrame: 668, text: GENERAL_MESSAGES.applied },
  { id: 'm7', kind: 'user', startFrame: 760, text: DESIGN_PROMPT_TEXT, chips: true },
  { id: 'm8', kind: 'assistant', startFrame: 850, text: GENERAL_MESSAGES.designIntro },
  {
    id: 'm9',
    kind: 'tools',
    startFrame: 906,
    items: [
      { spec: T.editHeroDesign, startFrame: 906, doneFrame: 921, human: 'Poliu o hero' },
      { spec: T.editBenefits, startFrame: 921, doneFrame: 936, human: 'Criou benefícios' },
      { spec: T.editTheme, startFrame: 936, doneFrame: 951, human: 'Refinou o visual' },
      { spec: T.editDashboard, startFrame: 951, doneFrame: 966, human: 'Melhorou o preview' },
    ],
  },
  { id: 'm10', kind: 'assistant', startFrame: 1000, text: GENERAL_MESSAGES.designDone },
]

/** Preview state (one persistent SaasLandingMock): skeleton → functional (after
 *  diff approve) → premium morph (during #design). */
export const PREVIEW = { revealFrame: 668, polishFrom: 878 } as const

/** Small badges (screen overlay, not title cards). */
export const BADGES = {
  preview: { start: 672, end: 744 },
  design: { start: 884, end: 980 },
} as const

/** Cursor interaction frames (session-local). */
export const CURSORS = {
  plan: { appear: 335, click: 360 },
  diff: { appear: 625, click: 650 },
  copy: { appear: 1200, click: 1225 },
} as const

/** Diff → preview connecting glow cue. */
export const CUE = { start: 650, end: 702 } as const

/** Deploy modal (overlays the session near the end). */
export const DEPLOY = { start: 1080, perStep: 14, live: 1190, copyPress: 1225, toastStart: 1230 } as const

/** Cinematic camera over the session (focal in CHILD space; all in-bounds). */
export const CAMERA = [
  { frame: 0, scale: 1, x: 960, y: 540 },
  { frame: 300, scale: 1, x: 960, y: 540 },
  { frame: 340, scale: 1.06, x: 960, y: 540 },
  { frame: 430, scale: 1.06, x: 960, y: 540 },
  { frame: 470, scale: 1, x: 960, y: 540 },
  { frame: 540, scale: 1.13, x: 940, y: 560 },
  { frame: 660, scale: 1.13, x: 940, y: 560 },
  { frame: 700, scale: 1.06, x: 1000, y: 520 },
  { frame: 850, scale: 1.06, x: 1000, y: 520 },
  { frame: 884, scale: 1.1, x: 1010, y: 520 },
  { frame: 980, scale: 1.1, x: 1010, y: 520 },
  { frame: 1030, scale: 1, x: 960, y: 540 },
  { frame: 1290, scale: 1, x: 960, y: 540 },
] as const
