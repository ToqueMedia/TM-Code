import React from 'react'
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile } from 'remotion'
import { GENERAL_SCENES, GENERAL_TOTAL } from './data/generalPromoTimings'
import { TITLE_CARDS } from './data/mockProject'
import { tokens } from './tokens'
import { TitleCard } from './components/general/TitleCard'
import { GeneralIntroScene } from './scenes/general/GeneralIntroScene'
import { SessionScene } from './scenes/general/SessionScene'
import { GeneralOpenBrowserScene } from './scenes/general/GeneralOpenBrowserScene'
import { GeneralFinalScene } from './scenes/general/GeneralFinalScene'

/**
 * General-audience promo (~56s @ 30fps). The whole middle is ONE persistent Chat
 * session (SessionScene) that accumulates the conversation and transforms the
 * connected preview; three micro title cards render on top of it, and the
 * browser + CTA are continuous segments after it. No fade-to-black anywhere.
 */
export const TMCodeGeneralPromo: React.FC = () => {
  const S = GENERAL_SCENES
  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <Audio
        src={staticFile('assets/audio/tmcode-promo-track-raw.mp3')}
        volume={(f) =>
          interpolate(f, [0, 24, GENERAL_TOTAL - 60, GENERAL_TOTAL - 6], [0, 0.85, 0.85, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })
        }
      />

      <Sequence from={S.intro.from} durationInFrames={S.intro.duration} name="Hook"><GeneralIntroScene /></Sequence>

      {/* Persistent Chat session (the whole middle). */}
      <Sequence from={S.session.from} durationInFrames={S.session.duration} name="Chat Session"><SessionScene /></Sequence>

      {/* Title cards render ON TOP of the session at their times. */}
      <Sequence from={S.tc1.from} durationInFrames={S.tc1.duration} name="• 1 Pede no Chat"><TitleCard text={TITLE_CARDS.prompt} /></Sequence>
      <Sequence from={S.tc2.from} durationInFrames={S.tc2.duration} name="• 2 Aprova e vê acontecer"><TitleCard text={TITLE_CARDS.approve} /></Sequence>
      <Sequence from={S.tc3.from} durationInFrames={S.tc3.duration} name="• 3 Publica online"><TitleCard text={TITLE_CARDS.publish} /></Sequence>

      <Sequence from={S.browser.from} durationInFrames={S.browser.duration} name="Open URL"><GeneralOpenBrowserScene /></Sequence>
      <Sequence from={S.cta.from} durationInFrames={S.cta.duration} name="CTA"><GeneralFinalScene /></Sequence>
    </AbsoluteFill>
  )
}
