// CTA (120f) — clean and direct: a mini browser of the published (premium) page,
// the TM Code logo + wordmark, the central message and one CTA. Fades in from the
// previous scene (no fade-to-black); holds on the CTA.

import React from 'react'
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { GeneralSceneBackground, RISE } from '../../components/general/sceneKit'
import { BrowserWindow, BROWSER_CHROME_HEIGHT } from '../../components/BrowserWindow'
import { SaasLandingMock } from '../../components/general/SaasLandingMock'
import { GENERAL_BRANDING } from '../../data/mockProject'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const CARD_W = 900
const CARD_H = 320

export const GeneralFinalScene: React.FC = () => {
  const frame = useCurrentFrame()
  const reveal = (from: number, distance = 16) => ({
    opacity: interpolate(frame, [from, from + 12], [0, 1], CLAMP),
    y: interpolate(frame, [from, from + 12], [distance, 0], RISE),
  })
  const logo = reveal(22)
  const head = reveal(40)
  const cta = reveal(58)
  const breath = 1 + 0.012 * Math.sin(frame / 18)

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.colors.bg.app }}>
      <GeneralSceneBackground drift />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <BrowserWindow title="Startup Demo" url="startup-demo.toquemedia.net" width={CARD_W} height={CARD_H}>
            <SaasLandingMock width={CARD_W - 2} height={CARD_H - 2 - BROWSER_CHROME_HEIGHT} revealFrame={0} polish={1} />
          </BrowserWindow>

          <div style={{ marginTop: 34, display: 'flex', alignItems: 'center', gap: 16, opacity: logo.opacity, transform: `translateY(${logo.y}px)` }}>
            <Img src={staticFile('assets/isologo.svg')} style={{ height: 56, filter: 'drop-shadow(0 6px 22px rgba(254,16,99,0.35))' }} />
            <span style={{ fontFamily: tokens.fontFamily.ui, fontSize: 52, fontWeight: 800, lineHeight: 1, backgroundImage: tokens.gradient.logoTitle, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>
              {GENERAL_BRANDING.name}
            </span>
          </div>

          <div style={{ marginTop: 18, fontFamily: tokens.fontFamily.ui, fontSize: 36, fontWeight: 800, lineHeight: 1.18, textAlign: 'center', opacity: head.opacity, transform: `translateY(${head.y}px)` }}>
            <div style={{ color: tokens.colors.text.primary }}>{GENERAL_BRANDING.headlineLines[0]}</div>
            <div style={{ backgroundImage: tokens.gradient.heroTitle, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>
              {GENERAL_BRANDING.headlineLines[1]}
            </div>
          </div>

          <div style={{ marginTop: 34, background: tokens.gradient.accentPrimary, color: '#ffffff', fontFamily: tokens.fontFamily.ui, fontSize: 26, fontWeight: 800, letterSpacing: '0.01em', padding: '20px 56px', borderRadius: tokens.radius.pill, boxShadow: '0 16px 44px rgba(254,16,99,0.55), 0 0 0 1px rgba(254,16,99,0.45)', opacity: cta.opacity, transform: `translateY(${cta.y}px) scale(${breath})` }}>
            {GENERAL_BRANDING.ctaPrefix + ' ' + GENERAL_BRANDING.url}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
