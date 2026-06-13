import React from 'react'
import { Composition, Folder } from 'remotion'
import { TMCodePromo } from './TMCodePromo'
import { FPS, HEIGHT, SCENES, TOTAL_DURATION_FRAMES, WIDTH } from './data/sceneTiming'
import { IntroScene } from './scenes/IntroScene'
import { PromptScene } from './scenes/PromptScene'
import { AgentSearchScene } from './scenes/AgentSearchScene'
import { DiffScene } from './scenes/DiffScene'
import { CommandScene } from './scenes/CommandScene'
import { E2EDemoScene } from './scenes/E2EDemoScene'
import { TestSuccessScene } from './scenes/TestSuccessScene'
import { FinalScene } from './scenes/FinalScene'

const base = { fps: FPS, width: WIDTH, height: HEIGHT } as const

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TMCodePromo"
        component={TMCodePromo}
        durationInFrames={TOTAL_DURATION_FRAMES}
        {...base}
      />
      {/* Individual scenes — handy for iterating in Remotion Studio */}
      <Folder name="scenes">
        <Composition id="S1-Intro" component={IntroScene} durationInFrames={SCENES.intro.duration} {...base} />
        <Composition id="S2-Prompt" component={PromptScene} durationInFrames={SCENES.prompt.duration} {...base} />
        <Composition id="S3-Search" component={AgentSearchScene} durationInFrames={SCENES.search.duration} {...base} />
        <Composition id="S4-Diff" component={DiffScene} durationInFrames={SCENES.diff.duration} {...base} />
        <Composition id="S4b-Command" component={CommandScene} durationInFrames={SCENES.command.duration} {...base} />
        <Composition id="S5-E2E" component={E2EDemoScene} durationInFrames={SCENES.e2e.duration} {...base} />
        <Composition id="S6-Tests" component={TestSuccessScene} durationInFrames={SCENES.tests.duration} {...base} />
        <Composition id="S7-Final" component={FinalScene} durationInFrames={SCENES.final.duration} {...base} />
      </Folder>
    </>
  )
}
