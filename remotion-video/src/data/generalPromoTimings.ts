// Global timeline for the SECOND promo — TMCodeGeneralPromo (general audience).
// 1920x1080 @ 30fps, 60s total (1800 frames). Every scene is mounted in its own
// <Sequence>; frames inside a scene are LOCAL (start at 0).
//
// This file is independent from sceneTiming.ts (the /te2e video) on purpose so
// the two compositions never interfere with each other.

export const FPS = 30
export const WIDTH = 1920
export const HEIGHT = 1080

export interface SceneSlot {
  from: number
  duration: number
}

export const GENERAL_SCENES = {
  /** 1 — Brand intro: isologo + wordmark + tagline */
  intro: { from: 0, duration: 120 },
  /** 2 — Two modes: Chat (rosa, RECOMMENDED) vs Terminal (roxo, POWER USERS) */
  modes: { from: 120, duration: 180 },
  /** 3 — Chat-first prompt: natural-language request typed in Chat Mode */
  prompt: { from: 300, duration: 180 },
  /** 4 — Agent works: reasoning + tool-call cascade + edits */
  work: { from: 480, duration: 300 },
  /** 5 — Diff + approval (approve/reject) */
  diff: { from: 780, duration: 210 },
  /** 6 — Live preview split (chat | browser) */
  preview: { from: 990, duration: 240 },
  /** 7 — One-click deploy (publish modal → live URL) */
  deploy: { from: 1230, duration: 240 },
  /** 8 — Power & security fast cuts (terminal, npm test, permission, git commit) */
  power: { from: 1470, duration: 180 },
  /** 9 — Final CTA */
  final: { from: 1650, duration: 150 },
} as const satisfies Record<string, SceneSlot>

export const GENERAL_TOTAL = 1800 // 60s @ 30fps

// Shared geometry so scenes agree on window placement. The MacWindowFrame adds a
// 44px titlebar (export TITLEBAR_HEIGHT) + 1px borders: body width = window.width - 2,
// body height ≈ window.height - 46.
export const GLAYOUT = {
  /** Centered IDE window for chat scenes (3, 4) and the diff scene (5). */
  window: { x: 160, y: 80, width: 1600, height: 920 },
  /** Scene 6 split — chat strip on the left, browser on the right. */
  splitChat: { x: 96, y: 96, width: 720, height: 888 },
  splitBrowser: { x: 856, y: 150, width: 968, height: 640 },
} as const
