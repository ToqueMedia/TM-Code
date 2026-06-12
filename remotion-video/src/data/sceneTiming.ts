// Global timeline — 1920x1080 @ 30fps, 40s total (1200 frames).
// Every scene is mounted in its own <Sequence>; frames inside a scene are LOCAL.

export const FPS = 30
export const WIDTH = 1920
export const HEIGHT = 1080

export interface SceneSlot {
  from: number
  duration: number
}

export const SCENES = {
  /** 1 — Brand intro: logo + "The Agent-First IDE" */
  intro: { from: 0, duration: 90 },
  /** 2 — TM Code window opens, greeting, user types the prompt */
  prompt: { from: 90, duration: 120 },
  /** 3 — Agent thinks, first search tool call, "7 results" highlight */
  search: { from: 210, duration: 90 },
  /** 4 — Read cascade, force-logout diff reveal with zooms */
  diff: { from: 300, duration: 210 },
  /** 4b — Dedicated /te2e command card: the feature this video sells */
  command: { from: 510, duration: 105 },
  /** 5 — Split screen: /te2e drives the browser; force logout click-through */
  e2e: { from: 615, duration: 210 },
  /** 6 — Reception login succeeds, validations pass, agent closes the loop */
  tests: { from: 825, duration: 180 },
  /** 7 — Zoom out + final branding CTA */
  final: { from: 1005, duration: 255 },
} as const satisfies Record<string, SceneSlot>

export const TOTAL_DURATION_FRAMES = 1260 // 42s @ 30fps

// Shared layout constants so scenes agree on geometry.
export const LAYOUT = {
  /** Full-width terminal window (scenes 2, 3, 4 and the test half of 6) */
  terminalWindow: { x: 160, y: 80, width: 1600, height: 920 },
  /** Scene 5 split view — browser shorter than the terminal so the demo app
      table fills it instead of floating in empty page background. */
  splitTerminal: { x: 40, y: 80, width: 860, height: 920 },
  splitBrowser: { x: 920, y: 200, width: 960, height: 620 },
  /** Scene 6 login browser */
  loginBrowser: { x: 360, y: 110, width: 1200, height: 860 },
} as const
