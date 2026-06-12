import React from 'react'
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile } from 'remotion'
import { SCENES } from './data/sceneTiming'
import { tokens } from './tokens'
import { IntroScene } from './scenes/IntroScene'
import { PromptScene } from './scenes/PromptScene'
import { AgentSearchScene } from './scenes/AgentSearchScene'
import { DiffScene } from './scenes/DiffScene'
import { CommandScene } from './scenes/CommandScene'
import { E2EDemoScene } from './scenes/E2EDemoScene'
import { TestSuccessScene } from './scenes/TestSuccessScene'
import { FinalScene } from './scenes/FinalScene'

export const TMCodePromo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      {/* Soundtrack — MiniMax music-2.6, 80s horror-funk instrumental
          (Thriller-inspired). The 2m02s source is cut at the composition end;
          the volume envelope fades in over 0.8s and out over the last 2.8s,
          landing with the closing fade to black (frames 1248-1260). */}
      <Audio
        src={staticFile('assets/audio/tmcode-promo-track-raw.mp3')}
        volume={(f) =>
          interpolate(f, [0, 24, 1176, 1254], [0, 0.9, 0.9, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })
        }
      />
      <Sequence from={SCENES.intro.from} durationInFrames={SCENES.intro.duration} name="1 — Intro">
        <IntroScene />
      </Sequence>
      <Sequence from={SCENES.prompt.from} durationInFrames={SCENES.prompt.duration} name="2 — Prompt">
        <PromptScene />
      </Sequence>
      <Sequence from={SCENES.search.from} durationInFrames={SCENES.search.duration} name="3 — Agent Search">
        <AgentSearchScene />
      </Sequence>
      <Sequence from={SCENES.diff.from} durationInFrames={SCENES.diff.duration} name="4 — Diff">
        <DiffScene />
      </Sequence>
      <Sequence from={SCENES.command.from} durationInFrames={SCENES.command.duration} name="4b — /te2e Command">
        <CommandScene />
      </Sequence>
      <Sequence from={SCENES.e2e.from} durationInFrames={SCENES.e2e.duration} name="5 — E2E Demo">
        <E2EDemoScene />
      </Sequence>
      <Sequence from={SCENES.tests.from} durationInFrames={SCENES.tests.duration} name="6 — Login + Tests">
        <TestSuccessScene />
      </Sequence>
      <Sequence from={SCENES.final.from} durationInFrames={SCENES.final.duration} name="7 — Final CTA">
        <FinalScene />
      </Sequence>
    </AbsoluteFill>
  )
}
