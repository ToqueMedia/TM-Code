import React from 'react'
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile } from 'remotion'
import { STORY, STORY_TOTAL } from './data/storyVertical'
import { tokens } from './tokens'
import { StoryHookScene } from './scenes/story/StoryHookScene'
import { StoryPromptScene } from './scenes/story/StoryPromptScene'
import { StoryPlanScene } from './scenes/story/StoryPlanScene'
import { StoryBuildScene } from './scenes/story/StoryBuildScene'
import { StoryDesignScene } from './scenes/story/StoryDesignScene'
import { StoryDeployScene } from './scenes/story/StoryDeployScene'
import { StoryBrowserScene } from './scenes/story/StoryBrowserScene'
import { StoryCtaScene } from './scenes/story/StoryCtaScene'

/**
 * Mobile-first 9:16 story (1080x1920, 30fps, 45s) for Stories/Reels/Status.
 * Purpose-built (not a re-layout of the 16:9 cut): big human text, large
 * preview, preview-dominant #design wow, large deploy URL, strong CTA. Readable
 * without sound. Same euphoric soundtrack as the other cuts.
 */
export const TMCodeGeneralPromoVertical: React.FC = () => {
  const S = STORY
  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <Audio
        src={staticFile('assets/audio/tmcode-promo-track-raw.mp3')}
        volume={(f) =>
          interpolate(f, [0, 20, STORY_TOTAL - 50, STORY_TOTAL - 6], [0, 0.85, 0.85, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })
        }
      />
      <Sequence from={S.hook.from} durationInFrames={S.hook.duration} name="Hook"><StoryHookScene /></Sequence>
      <Sequence from={S.prompt.from} durationInFrames={S.prompt.duration} name="Pede no Chat"><StoryPromptScene /></Sequence>
      <Sequence from={S.plan.from} durationInFrames={S.plan.duration} name="Plano"><StoryPlanScene /></Sequence>
      <Sequence from={S.build.from} durationInFrames={S.build.duration} name="Código"><StoryBuildScene /></Sequence>
      <Sequence from={S.design.from} durationInFrames={S.design.duration} name="#design"><StoryDesignScene /></Sequence>
      <Sequence from={S.deploy.from} durationInFrames={S.deploy.duration} name="Deploy"><StoryDeployScene /></Sequence>
      <Sequence from={S.browser.from} durationInFrames={S.browser.duration} name="Browser"><StoryBrowserScene /></Sequence>
      <Sequence from={S.cta.from} durationInFrames={S.cta.duration} name="CTA"><StoryCtaScene /></Sequence>
    </AbsoluteFill>
  )
}
