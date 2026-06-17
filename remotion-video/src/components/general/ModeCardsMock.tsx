// The two TM Code Welcome mode cards (Chat / Terminal) side by side. Used in the
// general promo to introduce the product's two entry points. Pink = Chat (brand),
// purple = Terminal (power users). Fully frame-driven: cards fade + rise in with a
// stagger, and an optional hover lift highlights the Chat card on cue.

import React from 'react'
import { Easing, interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { MODE_CARDS } from '../../data/mockProject'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const EASE_OUT = Easing.out(Easing.cubic)
const RISE = { ...CLAMP, easing: EASE_OUT } as const

export interface ModeCardsMockProps {
  startFrame: number
  /** When defined and the playhead reaches it, the Chat card lifts + glows. */
  hoverChatFrame?: number
}

interface ModeCardProps {
  /** Stagger index — card appears at startFrame + index * 9. */
  index: number
  startFrame: number
  accent: string
  badgeBg: string
  title: string
  badge: string
  line: string
  desc: string
  icon: React.ReactNode
  /** Hover lift cue (Chat card only); -1 disables it. */
  hoverFrame: number
}

const ChatBubbleIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={28} height={28} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M4 5.5C4 4.67 4.67 4 5.5 4h13c.83 0 1.5.67 1.5 1.5v8c0 .83-.67 1.5-1.5 1.5H9l-4 4v-4H5.5C4.67 15 4 14.33 4 13.5v-8Z"
      stroke={color}
      strokeWidth={1.8}
      strokeLinejoin="round"
    />
    <path d="M8 8.5h7M8 11h4.5" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
  </svg>
)

const ModeCard: React.FC<ModeCardProps> = ({
  index,
  startFrame,
  accent,
  badgeBg,
  title,
  badge,
  line,
  desc,
  icon,
  hoverFrame,
}) => {
  const frame = useCurrentFrame()
  const appearAt = startFrame + index * 9

  const opacity = interpolate(frame, [appearAt, appearAt + 12], [0, 1], CLAMP)
  const rise = interpolate(frame, [appearAt, appearAt + 14], [24, 0], RISE)

  const hovering = hoverFrame >= 0 && frame >= hoverFrame
  const lift = hovering ? interpolate(frame, [hoverFrame, hoverFrame + 10], [0, -10], RISE) : 0
  const glowT = hovering ? interpolate(frame, [hoverFrame, hoverFrame + 10], [0, 1], CLAMP) : 0

  return (
    <div
      style={{
        position: 'relative',
        width: 520,
        height: 360,
        boxSizing: 'border-box',
        borderRadius: 16,
        background: tokens.colors.bg.card,
        border: hovering
          ? '1.5px solid rgba(254, 16, 99, 0.6)'
          : `1px solid ${tokens.colors.border.glass}`,
        padding: 30,
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        opacity,
        transform: `translateY(${rise + lift}px)`,
        boxShadow: glowT > 0 ? `0 24px 60px rgba(254, 16, 99, ${0.22 * glowT})` : undefined,
        fontFamily: tokens.fontFamily.ui,
      }}
    >
      {/* Icon badge */}
      <div
        style={{
          width: 58,
          height: 58,
          borderRadius: 14,
          background: badgeBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </div>

      {/* Title + pill */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: tokens.colors.text.inverse }}>{title}</div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: accent,
            background: badgeBg,
            borderRadius: tokens.radius.pill,
            padding: '4px 10px',
          }}
        >
          {badge}
        </div>
      </div>

      {/* Line */}
      <div style={{ fontSize: 15, fontWeight: 500, color: tokens.colors.text.secondary }}>{line}</div>

      {/* Desc */}
      <div style={{ fontSize: 15, lineHeight: 1.5, color: tokens.colors.text.secondary }}>{desc}</div>
    </div>
  )
}

export const ModeCardsMock: React.FC<ModeCardsMockProps> = ({ startFrame, hoverChatFrame }) => {
  return (
    <div style={{ position: 'relative', display: 'flex', gap: 44 }}>
      <ModeCard
        index={0}
        startFrame={startFrame}
        accent={tokens.colors.accent.primary}
        badgeBg={tokens.colors.accent.primarySubtle}
        title={MODE_CARDS.chat.title}
        badge={MODE_CARDS.chat.badge}
        line={MODE_CARDS.chat.line}
        desc={MODE_CARDS.chat.desc}
        icon={<ChatBubbleIcon color={tokens.colors.accent.primary} />}
        hoverFrame={hoverChatFrame ?? -1}
      />
      <ModeCard
        index={1}
        startFrame={startFrame}
        accent={tokens.colors.accent.purple}
        badgeBg={tokens.colors.accent.purpleSubtle}
        title={MODE_CARDS.terminal.title}
        badge={MODE_CARDS.terminal.badge}
        line={MODE_CARDS.terminal.line}
        desc={MODE_CARDS.terminal.desc}
        icon={
          <span
            style={{
              fontFamily: tokens.fontFamily.mono,
              fontSize: 26,
              fontWeight: 700,
              color: tokens.colors.accent.purple,
            }}
          >
            {'>_'}
          </span>
        }
        hoverFrame={-1}
      />
    </div>
  )
}
