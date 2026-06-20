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
import { TMCodeGeneralPromo } from './TMCodeGeneralPromo'
import { TMCodeGeneralPromoVertical } from './TMCodeGeneralPromoVertical'
import { GENERAL_SCENES, GENERAL_TOTAL } from './data/generalPromoTimings'
import { STORY_TOTAL } from './data/storyVertical'
import { GeneralIntroScene } from './scenes/general/GeneralIntroScene'
import { SessionScene } from './scenes/general/SessionScene'
import { GeneralOpenBrowserScene } from './scenes/general/GeneralOpenBrowserScene'
import { GeneralFinalScene } from './scenes/general/GeneralFinalScene'

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

      {/* ── Second promo: general-audience presentation (60s) ── */}
      <Composition
        id="TMCodeGeneralPromo"
        component={TMCodeGeneralPromo}
        durationInFrames={GENERAL_TOTAL}
        {...base}
      />
      <Folder name="general">
        <Composition id="G1-Intro" component={GeneralIntroScene} durationInFrames={GENERAL_SCENES.intro.duration} {...base} />
        <Composition id="G2-Session" component={SessionScene} durationInFrames={GENERAL_SCENES.session.duration} {...base} />
        <Composition id="G3-Browser" component={GeneralOpenBrowserScene} durationInFrames={GENERAL_SCENES.browser.duration} {...base} />
        <Composition id="G4-Final" component={GeneralFinalScene} durationInFrames={GENERAL_SCENES.cta.duration} {...base} />
      </Folder>

      {/* ── Vertical 9:16 cut for social ── */}
      <Composition
        id="TMCodeGeneralPromoVertical"
        component={TMCodeGeneralPromoVertical}
        durationInFrames={STORY_TOTAL}
        fps={FPS}
        width={1080}
        height={1920}
      />
    </>
  )
}
