// Story scene 8 — CTA (120f / 4s). Big logo + two-line message + big pink CTA,
// with the published premium page as proof behind. CTA held > 2.5s.

import React from 'react'
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { GeneralSceneBackground, RISE } from '../../components/general/sceneKit'
import { BrowserWindow, BROWSER_CHROME_HEIGHT } from '../../components/BrowserWindow'
import { SaasLandingMock } from '../../components/general/SaasLandingMock'
import { GENERAL_BRANDING } from '../../data/mockProject'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const CARD_W = 900
const CARD_H = 560

export const StoryCtaScene: React.FC = () => {
  const frame = useCurrentFrame()
  const reveal = (from: number, d = 18) => ({
    opacity: interpolate(frame, [from, from + 12], [0, 1], CLAMP),
    y: interpolate(frame, [from, from + 12], [d, 0], RISE),
  })
  const logo = reveal(12)
  const head = reveal(22)
  const cta = reveal(32) // full by ~44 → held ~2.5s (scene is 120f)
  const breath = 1 + 0.014 * Math.sin(frame / 16)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <GeneralSceneBackground drift />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <BrowserWindow title="Startup Demo" url="startup-demo.toquemedia.net" width={CARD_W} height={CARD_H}>
            <SaasLandingMock width={CARD_W - 2} height={CARD_H - 2 - BROWSER_CHROME_HEIGHT} revealFrame={-12} polish={1} />
          </BrowserWindow>

          <div style={{ marginTop: 70, display: 'flex', alignItems: 'center', gap: 20, opacity: logo.opacity, transform: `translateY(${logo.y}px)` }}>
            <Img src={staticFile('assets/isologo.svg')} style={{ height: 84, filter: 'drop-shadow(0 8px 28px rgba(254,16,99,0.4))' }} />
            <span style={{ fontFamily: tokens.fontFamily.ui, fontSize: 84, fontWeight: 800, lineHeight: 1, backgroundImage: tokens.gradient.logoTitle, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>
              {GENERAL_BRANDING.name}
            </span>
          </div>

          <div style={{ marginTop: 34, fontFamily: tokens.fontFamily.ui, fontSize: 52, fontWeight: 800, lineHeight: 1.18, textAlign: 'center', opacity: head.opacity, transform: `translateY(${head.y}px)` }}>
            <div style={{ color: tokens.colors.text.primary }}>{GENERAL_BRANDING.headlineLines[0]}</div>
            <div style={{ backgroundImage: tokens.gradient.heroTitle, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{GENERAL_BRANDING.headlineLines[1]}</div>
          </div>

          <div style={{ marginTop: 50, background: tokens.gradient.accentPrimary, color: '#ffffff', fontFamily: tokens.fontFamily.ui, fontSize: 34, fontWeight: 800, letterSpacing: '0.01em', padding: '28px 64px', borderRadius: tokens.radius.pill, boxShadow: '0 20px 56px rgba(254,16,99,0.6), 0 0 0 1px rgba(254,16,99,0.45)', opacity: cta.opacity, transform: `translateY(${cta.y}px) scale(${breath})` }}>
            {GENERAL_BRANDING.ctaPrefix + ' ' + GENERAL_BRANDING.url}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
