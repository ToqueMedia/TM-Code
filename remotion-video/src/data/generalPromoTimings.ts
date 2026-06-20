// Global timeline for TMCodeGeneralPromo. The chat is ONE persistent session
// (a single accumulating timeline) — see chatTimeline.ts. Title cards, browser
// and CTA are overlays/segments around it. No fade-to-black anywhere.
// 1920x1080 @ 30fps.

export const FPS = 30
export const WIDTH = 1920
export const HEIGHT = 1080

export interface SceneSlot {
  from: number
  duration: number
}

// The persistent Chat session spans the whole middle of the video; title cards
// render ON TOP of it at their `from` times (tc1 at the very start of the
// session, tc2 mid, tc3 just before the deploy modal).
export const GENERAL_SCENES = {
  intro: { from: 0, duration: 90 },
  session: { from: 90, duration: 1290 }, // 90 → 1380
  tc1: { from: 90, duration: 24 }, // "1. Pede no Chat"
  tc2: { from: 330, duration: 24 }, // "2. Aprova e vê acontecer"
  tc3: { from: 1140, duration: 24 }, // "3. Publica online"
  browser: { from: 1380, duration: 204 }, // open the published URL (hold the page longer)
  cta: { from: 1584, duration: 180 }, // more breathing room
} as const satisfies Record<string, SceneSlot>

export const SESSION_FROM = 90
export const GENERAL_TOTAL = 1764 // ~59s @ 30fps

// MacWindowFrame adds a 44px titlebar (+1px borders): body width = window.width
// - 2, body height = window.height - 46, body origin = (window.x+1, window.y+46).
export const GLAYOUT = {
  window: { x: 160, y: 80, width: 1600, height: 920 },
  browser: { x: 280, y: 110, width: 1360, height: 860 },
} as const
