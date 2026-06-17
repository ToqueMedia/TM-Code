// The startup landing page in the connected preview. ONE component whose look is
// driven by `polish` (0 = plain functional page, 1 = premium landing). The
// #design scene animates polish 0 → 1 in real time, so the SAME page transforms
// radically: flat → gradient bg + hero glow, plain headline → big gradient
// headline + badge, flat button → big glowing gradient CTA, NO benefits → glass
// cards cascading in with icons, flat dashboard → framed dashboard with depth.
// BLUE accent only (never pink). Used premium (polish=1) in deploy/browser/CTA.

import React from 'react'
import { Easing, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'

export interface SaasLandingMockProps {
  width: number
  height: number
  /** Frame at which the page fades/rises in (preview load). */
  revealFrame?: number
  /** Static polish 0..1. Ignored if polishFrom is set. */
  polish?: number
  /** Animate polish 0 → 1 over ~64 frames from this frame (the #design morph). */
  polishFrom?: number
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const EASE = { ...CLAMP, easing: Easing.inOut(Easing.cubic) } as const
const DESIGN_W = 1000
const BAR_HEIGHTS = [70, 120, 92, 150, 110, 134] as const
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

const IconBolt: React.FC = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none"><path d="M13 2 L4 14 H11 L10 22 L20 9 H13 Z" fill="#fff" /></svg>
)
const IconLayers: React.FC = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none"><path d="M12 3 L22 8 L12 13 L2 8 Z M2 13 L12 18 L22 13 M2 17.5 L12 22.5 L22 17.5" stroke="#fff" strokeWidth={1.8} strokeLinejoin="round" /></svg>
)
const IconArrow: React.FC = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none"><path d="M5 19 L19 5 M9 5 H19 V15" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const BENEFITS = [
  { t: 'Rápido', d: 'Do pedido ao deploy em minutos.', Icon: IconBolt },
  { t: 'Sem fricção', d: 'Sem configurar ambientes nem servidores.', Icon: IconLayers },
  { t: 'Um clique', d: 'Publica e partilha o link logo a seguir.', Icon: IconArrow },
] as const

const InputPill: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ height: 46, boxSizing: 'border-box', display: 'flex', alignItems: 'center', padding: '0 16px', borderRadius: 10, background: tokens.colors.bg.input, border: `1px solid ${tokens.colors.border.glass}`, color: tokens.colors.text.muted, fontSize: 15 }}>
    {text}
  </div>
)

/** Blue primary button: flat (p=0) → gradient + glow + bigger + micro-pulse (p=1). */
const PrimaryBtn: React.FC<{ label: string; p: number; pulse: number }> = ({ label, p, pulse }) => (
  <div
    style={{
      position: 'relative',
      height: lerp(46, 52, p),
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 22px',
      borderRadius: 10,
      background: tokens.colors.accent.blue,
      color: '#ffffff',
      fontSize: lerp(15, 16, p),
      fontWeight: 700,
      whiteSpace: 'nowrap',
      transform: `scale(${1 + 0.12 * p + 0.015 * pulse})`,
      boxShadow: `0 ${20 * p}px ${58 * p}px rgba(59,142,234,${0.7 * p})`,
      overflow: 'hidden',
    }}
  >
    <span style={{ position: 'absolute', inset: 0, borderRadius: 10, background: `linear-gradient(135deg, ${tokens.colors.accent.blueBright} 0%, #6f7bff 100%)`, opacity: p }} aria-hidden />
    <span style={{ position: 'relative' }}>{label}</span>
  </div>
)

export const SaasLandingMock: React.FC<SaasLandingMockProps> = ({ width, height, revealFrame = 0, polish = 0, polishFrom }) => {
  const frame = useCurrentFrame()
  const scale = width / DESIGN_W
  const designHeight = height / scale
  const p = polishFrom !== undefined ? interpolate(frame, [polishFrom, polishFrom + 64], [0, 1], EASE) : polish
  const pulse = p > 0.85 ? Math.sin((frame - (polishFrom ?? 0)) / 9) : 0

  const contentOpacity = interpolate(frame, [revealFrame, revealFrame + 12], [0, 1], CLAMP)
  const contentRise = interpolate(frame, [revealFrame, revealFrame + 12], [16, 0], CLAMP)
  const skeletonOpacity = interpolate(frame, [revealFrame, revealFrame + 12], [1, 0], CLAMP)

  const h1Size = lerp(40, 56, p)
  const Sk: React.FC<{ t: number; l: number; w: number; h: number; r?: number; o?: number }> = ({ t, l, w, h, r = 6, o = 0.1 }) => (
    <div style={{ position: 'absolute', top: t, left: l, width: w, height: h, borderRadius: r, background: `rgba(255,255,255,${o})` }} />
  )

  return (
    <div style={{ width, height, overflow: 'hidden', position: 'relative', background: '#0f1217', fontFamily: tokens.fontFamily.ui }}>
      <div style={{ width: DESIGN_W, height: designHeight, position: 'absolute', top: 0, left: 0, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
        {/* Premium gradient background + hero glow (fade in with polish) */}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(160deg, #0f1217 0%, #121a2e 55%, #1a1430 100%)', opacity: p, pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', top: 20, left: '50%', width: 920, height: 470, transform: 'translateX(-50%)', background: 'radial-gradient(ellipse at center, rgba(59,142,234,0.32) 0%, rgba(163,113,247,0.18) 45%, transparent 72%)', opacity: p, pointerEvents: 'none' }} />

        {/* Loading skeleton — ABOVE the gradient so the "loading" body never looks empty */}
        <div style={{ position: 'absolute', inset: 0, opacity: skeletonOpacity, pointerEvents: 'none' }}>
          <Sk t={22} l={56} w={150} h={20} />
          <Sk t={22} l={740} w={200} h={20} o={0.08} />
          <Sk t={150} l={250} w={500} h={40} />
          <Sk t={210} l={330} w={340} h={16} o={0.08} />
          <Sk t={270} l={300} w={190} h={44} r={10} />
          <Sk t={270} l={510} w={190} h={44} r={10} />
          <Sk t={356} l={56} w={888} h={150} r={12} o={0.06} />
        </div>

        <div style={{ opacity: contentOpacity, transform: `translateY(${contentRise}px)`, position: 'relative', display: 'flex', flexDirection: 'column', minHeight: designHeight }}>
          {/* Navbar */}
          <div style={{ height: 64, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 56px', boxSizing: 'border-box', borderBottom: `1px solid rgba(255,255,255,${0.06 + 0.04 * p})` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 26, height: 26, borderRadius: 12, background: tokens.colors.accent.blue, boxShadow: `0 0 ${18 * p}px rgba(59,142,234,${0.8 * p})` }} />
              <span style={{ fontSize: 17, fontWeight: 700, color: tokens.colors.text.primary }}>Startup Demo</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
              {['Produto', 'Preços'].map((l) => (<span key={l} style={{ fontSize: 15, color: tokens.colors.text.secondary, fontWeight: 500 }}>{l}</span>))}
              <span style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary, border: '1px solid rgba(255,255,255,0.14)', borderRadius: tokens.radius.pill, padding: '7px 18px' }}>Entrar</span>
            </div>
          </div>

          {/* Body */}
          <div style={{ flex: 1, padding: `${lerp(40, 60, p)}px 56px 48px`, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', position: 'relative' }}>
            {/* Premium badge above the title */}
            <div style={{ height: 34 * p, opacity: p, overflow: 'hidden', marginBottom: 16 * p }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 9999, fontSize: 13, fontWeight: 600, color: tokens.colors.accent.blueBright, background: 'rgba(59,142,234,0.12)', border: '1px solid rgba(59,142,234,0.4)' }}>
                <span style={{ width: 7, height: 7, borderRadius: 9999, background: tokens.colors.accent.blueBright }} />
                Construído com IA
              </span>
            </div>

            {/* Hero title (plain white → gradient + glow) */}
            <div style={{ position: 'relative' }}>
              <h1 style={{ margin: 0, fontSize: h1Size, lineHeight: 1.06, fontWeight: 800, color: tokens.colors.text.primary, letterSpacing: '-0.02em', textShadow: `0 0 ${48 * p}px rgba(96,165,250,${0.6 * p})` }}>
                Lança a tua ideia mais rápido
              </h1>
              <h1 aria-hidden style={{ position: 'absolute', inset: 0, margin: 0, fontSize: h1Size, lineHeight: 1.06, fontWeight: 800, letterSpacing: '-0.02em', backgroundImage: 'linear-gradient(120deg, #ffffff 0%, #93c5fd 55%, #b79cff 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', opacity: p }}>
                Lança a tua ideia mais rápido
              </h1>
            </div>
            <p style={{ margin: `${lerp(14, 18, p)}px 0 0`, fontSize: lerp(18, 20, p), color: p > 0.5 ? tokens.colors.text.primary : tokens.colors.text.secondary }}>
              Cria, valida e publica com ajuda da IA.
            </p>

            {/* Email / password auth card */}
            <div style={{ marginTop: lerp(26, 34, p), width: 440, boxSizing: 'border-box', padding: 18, borderRadius: 14, background: `rgba(255,255,255,${0.03 + 0.03 * p})`, border: `1px solid rgba(59,142,234,${0.1 + 0.32 * p})`, textAlign: 'left', boxShadow: `0 ${22 * p}px ${54 * p}px rgba(0,0,0,${0.5 * p})` }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.text.muted, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Entrar com email</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <InputPill text="email@exemplo.com" />
                <InputPill text="••••••••••" />
                <PrimaryBtn label="Entrar" p={p} pulse={pulse} />
              </div>
            </div>

            {/* Waitlist */}
            <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 14, color: tokens.colors.text.muted }}>Ou junta-te à lista de espera</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ width: 280 }}><InputPill text="o-teu@email.com" /></div>
                <PrimaryBtn label="Entrar na lista de espera" p={p} pulse={pulse} />
              </div>
            </div>

            {/* Benefits — 3 glass cards cascading in */}
            <div style={{ marginTop: lerp(0, 40, p), height: 156 * Math.min(1, p * 1.15), opacity: Math.min(1, p * 1.4), overflow: 'hidden', width: '100%', display: 'flex', gap: 18 }}>
              {BENEFITS.map((b, i) => {
                const lp = interpolate(p, [0.2 + i * 0.16, 0.6 + i * 0.16], [0, 1], CLAMP)
                return (
                  <div key={b.t} style={{ flex: 1, boxSizing: 'border-box', padding: 20, borderRadius: 14, background: 'linear-gradient(160deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.03) 100%)', border: '1px solid rgba(255,255,255,0.14)', textAlign: 'left', boxShadow: '0 16px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)', opacity: lp, transform: `translateY(${(1 - lp) * 22}px) scale(${0.96 + 0.04 * lp})` }}>
                    <span style={{ display: 'inline-flex', width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', background: `linear-gradient(135deg, ${tokens.colors.accent.blueBright}, ${tokens.colors.accent.blue})`, boxShadow: '0 6px 16px rgba(59,142,234,0.45)' }}>
                      <b.Icon />
                    </span>
                    <div style={{ marginTop: 12, fontSize: 17, fontWeight: 700, color: tokens.colors.text.primary }}>{b.t}</div>
                    <div style={{ marginTop: 4, fontSize: 13, color: tokens.colors.text.secondary, lineHeight: 1.45 }}>{b.d}</div>
                  </div>
                )
              })}
            </div>

            {/* Dashboard preview — flat (base) → framed with depth (premium) */}
            <div style={{ marginTop: 32, width: '100%', boxSizing: 'border-box', borderRadius: 16, background: `rgba(255,255,255,${0.03 + 0.02 * p})`, border: `1px solid rgba(255,255,255,${0.07 + 0.07 * p})`, transform: `translateY(${-8 * p}px)`, boxShadow: `0 ${42 * p}px ${100 * p}px rgba(0,0,0,${0.68 * p})`, overflow: 'hidden' }}>
              {/* Window header (premium) */}
              <div style={{ height: 38 * p, opacity: p, overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 8, padding: '0 18px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {[tokens.colors.windowControl.close, tokens.colors.windowControl.minimize, tokens.colors.windowControl.maximize].map((c, i) => (
                  <span key={i} style={{ width: 10, height: 10, borderRadius: 9999, background: c }} />
                ))}
                <span style={{ marginLeft: 8, fontSize: 12, color: tokens.colors.text.muted, letterSpacing: '0.04em' }}>Painel</span>
              </div>
              <div style={{ padding: 28, display: 'flex', gap: 28 }}>
                <div style={{ flex: '1 1 auto', height: 184, display: 'flex', alignItems: 'flex-end', gap: 18, paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.06)', position: 'relative' }}>
                  {BAR_HEIGHTS.map((h, i) => (
                    <div key={i} style={{ flex: '1 1 0', height: h, borderRadius: '6px 6px 0 0', background: p > 0.5 ? `linear-gradient(180deg, ${tokens.colors.accent.blueBright}, ${tokens.colors.accent.blue})` : tokens.colors.accent.blue, opacity: 0.5 + 0.5 * (h / 156), boxShadow: p > 0.5 ? '0 6px 18px rgba(59,142,234,0.35)' : undefined }} />
                  ))}
                  {/* premium sparkline */}
                  <svg width="100%" height="60" viewBox="0 0 300 60" preserveAspectRatio="none" style={{ position: 'absolute', left: 0, bottom: 24, opacity: p }}>
                    <path d="M0 50 L50 38 L100 44 L150 22 L200 30 L250 10 L300 16" fill="none" stroke={tokens.colors.accent.greenBright} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div style={{ flex: '0 0 220px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {[
                    { label: 'Utilizadores', value: '2.481', up: '+12%' },
                    { label: 'MRR', value: '€12.4k', up: '+8%' },
                    { label: 'Conversão', value: '4.8%', up: '+1.2%' },
                  ].map((stat) => (
                    <div key={stat.label} style={{ boxSizing: 'border-box', padding: '12px 16px', borderRadius: 10, background: `rgba(255,255,255,${0.03 + 0.02 * p})`, border: `1px solid rgba(255,255,255,${0.06 + 0.04 * p})`, textAlign: 'left', boxShadow: p > 0.5 ? '0 8px 20px rgba(0,0,0,0.35)' : undefined }}>
                      <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: tokens.colors.text.muted, fontWeight: 600 }}>{stat.label}</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <div style={{ marginTop: 4, fontSize: 22, fontWeight: 800, color: tokens.colors.accent.blueBright }}>{stat.value}</div>
                        <span style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.accent.greenBright, opacity: p }}>{stat.up}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
