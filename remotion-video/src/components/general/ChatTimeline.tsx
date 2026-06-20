// Renders the single persistent CHAT_TIMELINE by session-local frame. Every
// entry appears when its startFrame passes and STAYS (accumulating history);
// nothing is recreated per scene. Each entry expands in (maxHeight) so the chat
// scrolls smoothly downward (bottom-anchored by ChatModeMock).

import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { tokens } from '../../tokens'
import { ChatMessageBubble } from './ChatMessageBubble'
import { PlanApprovalMock } from './PlanApprovalMock'
import { ApprovalButtonsMock } from './ApprovalButtonsMock'
import { ToolCallRow } from '../ToolCallRow'
import { StructuredDiff } from '../StructuredDiff'
import { CHAT_TIMELINE, type ChatEntry } from '../../data/chatTimeline'
import { heroDiff, HERO_FOCUS } from '../../data/generalPromoDiff'

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

/** Wraps each entry so it expands in (smooth scroll) and never reserves space early. */
const Entry: React.FC<{ startFrame: number; children: React.ReactNode }> = ({ startFrame, children }) => {
  const f = useCurrentFrame()
  if (f < startFrame) return null
  const grow = interpolate(f, [startFrame, startFrame + 12], [0, 720], CLAMP)
  const op = interpolate(f, [startFrame, startFrame + 8], [0, 1], CLAMP)
  return <div style={{ maxHeight: grow, overflow: 'hidden', opacity: op, flexShrink: 0 }}>{children}</div>
}

const chipStyle = (color: string): React.CSSProperties => ({
  display: 'inline-block',
  background: 'rgba(255,255,255,0.06)',
  border: `1px solid ${color}`,
  color,
  borderRadius: 6,
  padding: '1px 8px',
  fontWeight: 600,
})

const renderChips = (visible: string): React.ReactNode[] => {
  const parts = visible.split(' ')
  const nodes: React.ReactNode[] = []
  parts.forEach((tok, i) => {
    const s = tok.slice(0, 1)
    if ((s === '/' || s === '#') && tok.length > 1) {
      const color = s === '/' ? tokens.colors.accent.primary : tokens.colors.accent.green
      nodes.push(<span key={i} style={chipStyle(color)}>{tok}</span>)
    } else {
      nodes.push(<React.Fragment key={i}>{tok}</React.Fragment>)
    }
    if (i < parts.length - 1) nodes.push(<React.Fragment key={`s${i}`}> </React.Fragment>)
  })
  return nodes
}

const UserChipBubble: React.FC<{ text: string; startFrame: number }> = ({ text, startFrame }) => {
  const f = useCurrentFrame()
  const typed = Math.floor(Math.max(0, f - startFrame) * 2.4)
  const visible = text.slice(0, typed)
  const done = typed >= text.length
  const caret = !done || Math.floor(f / 16) % 2 === 0
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: 720,
        background: tokens.colors.accent.primarySubtle,
        borderLeft: '3px solid ' + tokens.colors.accent.primary,
        borderRadius: '0 12px 12px 0',
        padding: '14px 18px',
        color: tokens.colors.text.primary,
        fontSize: 21,
        fontFamily: tokens.fontFamily.ui,
        lineHeight: 1.55,
      }}
    >
      {renderChips(visible)}
      <span style={{ display: 'inline-block', width: 11, height: 22, background: tokens.colors.terminal.cursor, marginLeft: 2, verticalAlign: 'text-bottom', opacity: caret ? 0.9 : 0 }} />
    </div>
  )
}

const renderEntry = (e: ChatEntry): React.ReactNode => {
  switch (e.kind) {
    case 'user':
      return e.chips ? (
        <UserChipBubble text={e.text} startFrame={e.startFrame} />
      ) : (
        <ChatMessageBubble role="user" text={e.text} startFrame={e.startFrame} maxWidth={720} />
      )
    case 'assistant':
      return <ChatMessageBubble role="assistant" text={e.text} startFrame={e.startFrame} maxWidth={700} />
    case 'plan':
      return <PlanApprovalMock startFrame={e.startFrame} approvePressFrame={e.approvePressFrame} approvedFrame={e.approvedFrame} />
    case 'tools':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {e.items.map((it, i) => (
            <ToolCallRow key={i} spec={it.spec} startFrame={it.startFrame} doneFrame={it.doneFrame} humanLabel={it.human} />
          ))}
        </div>
      )
    case 'diff':
      return (
        <div>
          <StructuredDiff
            diff={heroDiff}
            startFrame={e.startFrame}
            framesPerLine={4}
            fontSize={20}
            highlightLines={HERO_FOCUS}
            highlightStartFrame={e.startFrame + 54}
            highlightEndFrame={e.approvedFrame + 30}
            highlightColor={tokens.colors.accent.greenBright}
            highlightTint="rgba(46,160,67,0.14)"
          />
          <div style={{ marginTop: 8 }}>
            <ApprovalButtonsMock
              startFrame={e.approveAppearFrame}
              approvePressFrame={e.approvePressFrame}
              approvedFrame={e.approvedFrame}
              approveLabel="Aprovar alterações"
              rejectLabel="Rejeitar"
              approvedLabel="Alterações aprovadas"
            />
          </div>
        </div>
      )
    default:
      return null
  }
}

export const ChatTimeline: React.FC = () => (
  <>
    {CHAT_TIMELINE.map((e) => (
      <Entry key={e.id} startFrame={e.startFrame}>
        {renderEntry(e)}
      </Entry>
    ))}
  </>
)
