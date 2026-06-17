// The single persistent TM Code window used across the chat scenes (2-7).
// Centralizes the window geometry so the chat + connected preview read as ONE
// surface from scene to scene, and exposes a deterministic cursor target for the
// bottom-anchored Approve button (scene 4).

import React from 'react'
import { GLAYOUT } from '../../data/generalPromoTimings'
import { SAAS_PROJECT } from '../../data/mockProject'
import { MacWindowFrame } from '../MacWindowFrame'
import { ChatModeMock } from './ChatModeMock'
import { APPROVAL_LAYOUT } from './ApprovalButtonsMock'

const W = GLAYOUT.window
export const CHAT_BODY = {
  left: W.x + 1,
  top: W.y + 46,
  width: W.width - 2, // 1598
  height: W.height - 46, // 874
} as const

const CHAT_PAD_X = 34
const CHAT_PAD_BOTTOM = 30
export const DEFAULT_LEFT_RATIO = 0.5

/**
 * Screen-space center of the Approve button when ApprovalButtonsMock is the
 * bottom-anchored last child of the chat column (scene 4). Flex `flex-end`
 * pins it to the bottom, so its position is deterministic regardless of the
 * diff height above it.
 */
export const approveButtonTarget = (leftRatio: number = DEFAULT_LEFT_RATIO) => {
  const leftW = Math.round(CHAT_BODY.width * leftRatio)
  const contentRight = CHAT_BODY.left + leftW - CHAT_PAD_X
  const contentBottom = CHAT_BODY.top + CHAT_BODY.height - CHAT_PAD_BOTTOM
  return {
    x: contentRight - APPROVAL_LAYOUT.approveFromRight,
    y: contentBottom - APPROVAL_LAYOUT.centerY,
  }
}

/**
 * Screen-space center of the full-width "Aprovar plano" button (PlanApprovalMock)
 * when the card is the bottom-anchored last child of the chat column. The button
 * sits at the card bottom (height 52), so its center is the chat column center,
 * 26px up from the chat content bottom.
 */
export const approvePlanTarget = (leftRatio: number = DEFAULT_LEFT_RATIO) => {
  const leftW = Math.round(CHAT_BODY.width * leftRatio)
  const contentLeft = CHAT_BODY.left + CHAT_PAD_X
  const contentWidth = leftW - CHAT_PAD_X * 2
  const contentBottom = CHAT_BODY.top + CHAT_BODY.height - CHAT_PAD_BOTTOM
  return { x: contentLeft + contentWidth / 2, y: contentBottom - 26 }
}

export interface ChatWindowProps {
  chat: React.ReactNode
  promptBar?: React.ReactNode
  preview?: React.ReactNode
  previewDim?: boolean
  leftRatio?: number
  chatBottomAnchor?: boolean
  entranceFrame?: number
}

export const ChatWindow: React.FC<ChatWindowProps> = ({
  chat,
  promptBar,
  preview,
  previewDim,
  leftRatio = DEFAULT_LEFT_RATIO,
  chatBottomAnchor = true,
  entranceFrame,
}) => {
  return (
    <div style={{ position: 'absolute', left: W.x, top: W.y }}>
      <MacWindowFrame
        title="TM Code"
        subtitle={SAAS_PROJECT.name}
        width={W.width}
        height={W.height}
        entranceFrame={entranceFrame}
      >
        <ChatModeMock
          width={CHAT_BODY.width}
          height={CHAT_BODY.height}
          chat={chat}
          promptBar={promptBar}
          preview={preview}
          previewDim={previewDim}
          leftRatio={leftRatio}
          chatBottomAnchor={chatBottomAnchor}
        />
      </MacWindowFrame>
    </div>
  )
}
