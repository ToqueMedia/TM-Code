import React from 'react'
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile } from 'remotion'
import { GENERAL_SCENES, GENERAL_TOTAL } from './data/generalPromoTimings'
import { tokens } from './tokens'
import { GeneralIntroScene } from './scenes/general/GeneralIntroScene'
import { GeneralModesScene } from './scenes/general/GeneralModesScene'
import { GeneralPromptScene } from './scenes/general/GeneralPromptScene'
import { GeneralAgentWorkScene } from './scenes/general/GeneralAgentWorkScene'
import { GeneralDiffApproveScene } from './scenes/general/GeneralDiffApproveScene'
import { GeneralPreviewScene } from './scenes/general/GeneralPreviewScene'
import { GeneralDeployScene } from './scenes/general/GeneralDeployScene'
import { GeneralPowerSecurityScene } from './scenes/general/GeneralPowerSecurityScene'
import { GeneralFinalScene } from './scenes/general/GeneralFinalScene'

/**
 * Second promo — a 60s (1800 frame @ 30fps) general-audience presentation of
 * TM Code. Distinct from TMCodePromo (the /te2e video); shares only the
 * component library, tokens and soundtrack. Each scene is mounted in its own
 * <Sequence> so its frames are local.
 */
export const TMCodeGeneralPromo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      {/* Reuse the existing MiniMax instrumental; fade in over 0.8s and out over
          the final pull-back so it lands with scene 9's fade to black. */}
      <Audio
        src={staticFile('assets/audio/tmcode-promo-track-raw.mp3')}
        volume={(f) =>
          interpolate(f, [0, 24, GENERAL_TOTAL - 60, GENERAL_TOTAL - 6], [0, 0.85, 0.85, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })
        }
      />

      <Sequence from={GENERAL_SCENES.intro.from} durationInFrames={GENERAL_SCENES.intro.duration} name="1 — Intro">
        <GeneralIntroScene />
      </Sequence>
      <Sequence from={GENERAL_SCENES.modes.from} durationInFrames={GENERAL_SCENES.modes.duration} name="2 — Two Modes">
        <GeneralModesScene />
      </Sequence>
      <Sequence from={GENERAL_SCENES.prompt.from} durationInFrames={GENERAL_SCENES.prompt.duration} name="3 — Prompt">
        <GeneralPromptScene />
      </Sequence>
      <Sequence from={GENERAL_SCENES.work.from} durationInFrames={GENERAL_SCENES.work.duration} name="4 — Agent Works">
        <GeneralAgentWorkScene />
      </Sequence>
      <Sequence from={GENERAL_SCENES.diff.from} durationInFrames={GENERAL_SCENES.diff.duration} name="5 — Diff + Approve">
        <GeneralDiffApproveScene />
      </Sequence>
      <Sequence from={GENERAL_SCENES.preview.from} durationInFrames={GENERAL_SCENES.preview.duration} name="6 — Live Preview">
        <GeneralPreviewScene />
      </Sequence>
      <Sequence from={GENERAL_SCENES.deploy.from} durationInFrames={GENERAL_SCENES.deploy.duration} name="7 — Deploy">
        <GeneralDeployScene />
      </Sequence>
      <Sequence from={GENERAL_SCENES.power.from} durationInFrames={GENERAL_SCENES.power.duration} name="8 — Power & Security">
        <GeneralPowerSecurityScene />
      </Sequence>
      <Sequence from={GENERAL_SCENES.final.from} durationInFrames={GENERAL_SCENES.final.duration} name="9 — Final CTA">
        <GeneralFinalScene />
      </Sequence>
    </AbsoluteFill>
  )
}
