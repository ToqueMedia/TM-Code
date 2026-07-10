import { memo, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text, Textarea } from '@chakra-ui/react'
import {
  VscCallOutgoing,
  VscClose,
  VscCommentDiscussion,
  VscDeviceCameraVideo,
  VscMic,
  VscMicFilled,
  VscMute,
  VscSend,
} from 'react-icons/vsc'
import { useTranslation } from '@/i18n'
import { tokens } from '@/theme/tokens'
import { useAuthStore } from '@/stores/authStore'
import { useCollabStore } from '@/stores/collabStore'
import { sendChatMessage, stopLivePreview } from '@/services/collab/collabSessionService'
import { joinVoiceCall, leaveVoiceCall, toggleVoiceMute } from '@/services/collab/collabVoice'
import { startScreenShare, stopScreenShare, watchPresenter } from '@/services/collab/collabScreen'
import { useTeamTyping } from '@/hooks/useTeamTyping'
import type { PeerPath } from '@/services/collab/collabMesh'
import { ElapsedLabel } from './ElapsedLabel'
import { PeerPathBadge } from './PeerPathBadge'
import type { ChatMessage } from '@/services/collab/collabChat'

/** Drawer width — fixed like the other side drawers (terminal/checkpoints). */
const DRAWER_W = 360

/** Consecutive messages from the same author within this window collapse
 *  under one avatar/name header (Slack-style grouping). */
const GROUP_WINDOW_MS = 5 * 60_000

/** Deterministic avatar hue from the uid — stable across sessions/peers
 *  without any coordination. */
function avatarHue(uid: string): number {
  let h = 0
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function timeLabel(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function Avatar({ uid, name }: { uid: string; name: string }) {
  const hue = avatarHue(uid)
  return (
    <Flex
      w="24px"
      h="24px"
      borderRadius="6px"
      align="center"
      justify="center"
      flexShrink={0}
      bg={`hsl(${hue}, 45%, 28%)`}
      color={`hsl(${hue}, 70%, 82%)`}
      fontSize="10px"
      fontWeight="700"
      userSelect="none"
    >
      {initialsOf(name)}
    </Flex>
  )
}

/** Memoized transcript — the panel re-renders on every roster/typing/voice
 *  tick, and hundreds of message rows must not re-reconcile for any of that.
 *  Only a `chat` change re-renders this subtree. Flat left-aligned rows with
 *  avatar + name + time headers, consecutive messages grouped per author. */
const ChatMessages = memo(function ChatMessages({
  chat,
  selfUid,
  selfLabel,
}: {
  chat: ChatMessage[]
  selfUid?: string
  selfLabel: string
}) {
  return (
    <>
      {chat.map((m, i) => {
        const prev = chat[i - 1]
        const grouped = !!prev && prev.uid === m.uid && m.ts - prev.ts < GROUP_WINDOW_MS
        const mine = m.uid === selfUid
        return (
          <Flex key={m.id} gap={2} mt={grouped ? '2px' : 3} align="flex-start" role="group">
            {grouped ? (
              <Box w="24px" flexShrink={0} />
            ) : (
              <Avatar uid={m.uid} name={m.name} />
            )}
            <Box minW={0} flex={1}>
              {!grouped && (
                <Flex align="baseline" gap={2} mb="1px">
                  <Text
                    fontSize="11px"
                    fontWeight="600"
                    color={mine ? tokens.colors.accent.primary : tokens.colors.text.primary}
                    lineClamp={1}
                  >
                    {mine ? selfLabel : m.name}
                  </Text>
                  <Text fontSize="9px" color={tokens.colors.text.muted} flexShrink={0}>
                    {timeLabel(m.ts)}
                  </Text>
                </Flex>
              )}
              <Text
                fontSize="12px"
                lineHeight="1.5"
                color={tokens.colors.text.secondary}
                whiteSpace="pre-wrap"
                wordBreak="break-word"
              >
                {m.text}
              </Text>
            </Box>
          </Flex>
        )
      })}
    </>
  )
})

/** One participant pill in the voice bar: mic state + speaking highlight +
 *  connection-path badge (direct/TURN/relay — how MY link to them flows). */
function VoiceChip({
  name,
  muted,
  speaking,
  path,
}: {
  name: string
  muted: boolean
  speaking: boolean
  path?: PeerPath
}) {
  return (
    <Flex
      align="center"
      gap={1}
      px={1.5}
      py="2px"
      borderRadius="4px"
      bg={tokens.colors.bg.panelAlt}
      border={`1px solid ${speaking ? tokens.colors.accent.greenBright : tokens.colors.border.default}`}
    >
      {muted ? (
        <VscMute size={11} color={tokens.colors.accent.red} />
      ) : (
        <VscMicFilled
          size={11}
          color={speaking ? tokens.colors.accent.greenBright : tokens.colors.text.muted}
        />
      )}
      <Text fontSize="10px" color={tokens.colors.text.secondary} lineClamp={1} maxW="90px">
        {name}
      </Text>
      <PeerPathBadge path={path} size={10} />
    </Flex>
  )
}

/** Small square icon button used across the drawer header/sections. */
function IconButton({
  label,
  onClick,
  dimmed,
  children,
}: {
  label: string
  onClick: () => void
  dimmed?: boolean
  children: React.ReactNode
}) {
  return (
    <Box
      as="button"
      display="flex"
      alignItems="center"
      justifyContent="center"
      w="24px"
      h="24px"
      borderRadius="6px"
      color={tokens.colors.text.secondary}
      opacity={dimmed ? 0.5 : 1}
      cursor="pointer"
      transition={`all ${tokens.transition.fast}`}
      _hover={{ bg: 'rgba(255, 255, 255, 0.08)', color: tokens.colors.text.primary }}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </Box>
  )
}

/** Uppercase micro-label that heads the voice/screen strips. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="9px"
      fontWeight="700"
      letterSpacing="0.08em"
      textTransform="uppercase"
      color={tokens.colors.text.muted}
    >
      {children}
    </Text>
  )
}

/**
 * Team chat DRAWER. Messages travel P2P over the WebRTC control channel
 * (DTLS, never a server); optional local history lives in app-managed project
 * state. Mounted once in MainLayout's drawer row — same slide-in pattern as
 * the terminal drawer (width 0↔fixed, content translates), pushing the
 * workspace instead of floating over it. The voice call / screen share keep
 * running with the drawer closed; these strips are just their control surface.
 */
export function TeamChatPanel() {
  const t = useTranslation()
  const open = useCollabStore((s) => s.chatOpen)
  const chat = useCollabStore((s) => s.chat)
  const peers = useCollabStore((s) => s.peers)
  const peerPaths = useCollabStore((s) => s.peerPaths)
  const connected = useCollabStore((s) => s.connected)
  const sharing = useCollabStore((s) => s.sharingPreview)
  const setChatOpen = useCollabStore((s) => s.setChatOpen)
  const inVoice = useCollabStore((s) => s.voiceInCall)
  const voiceJoining = useCollabStore((s) => s.voiceJoining)
  const voiceMuted = useCollabStore((s) => s.voiceMuted)
  const speakingSelf = useCollabStore((s) => s.voiceSpeakingSelf)
  const voiceCountdown = useCollabStore((s) => s.voiceCountdown)
  const voiceRoster = useCollabStore((s) => s.voiceRoster)
  const screenSharing = useCollabStore((s) => s.screenSharing)
  const screenStarting = useCollabStore((s) => s.screenStarting)
  const screenPresenter = useCollabStore((s) => s.screenPresenter)
  const screenWatching = useCollabStore((s) => s.screenWatching)
  const selfUid = useAuthStore((s) => s.user?.uid)
  const { notifyTyping, stopTyping, typingLabel } = useTeamTyping()
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Raw timestamps only — the ticking label lives in <ElapsedLabel/> so the
  // 1 Hz timer never re-renders this panel (the chat list is expensive).
  const voiceStartedAt = useCollabStore((s) => s.voiceCallStartedAt)
  const screenSince = useCollabStore((s) =>
    s.screenSharing ? s.screenSharingSince : s.screenPresenterSince,
  )

  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [chat, open, typingLabel])

  // Drawer ergonomics: focus the composer on open, close on Escape.
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setChatOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, setChatOpen])

  // Grow the composer to fit its content (capped by maxH on the Textarea).
  const autoGrow = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    sendChatMessage(text)
    setDraft('')
    stopTyping()
    if (inputRef.current) inputRef.current.style.height = 'auto'
  }

  const voicePeers = Object.entries(voiceRoster)
  const callActive = inVoice || voicePeers.length > 0
  const participantCount = voicePeers.length + (inVoice ? 1 : 0)
  // Roster/presenter are keyed by uid; connection paths by mesh peerId.
  const pathForUid = (uid: string): PeerPath | undefined => {
    const peer = peers.find((p) => p.uid === uid)
    return peer ? peerPaths[peer.peerId] : undefined
  }

  return (
    <Flex
      direction="column"
      w={open ? `${DRAWER_W}px` : '0px'}
      h="100%"
      flexShrink={0}
      bg={tokens.colors.bg.panel}
      borderLeft={open ? '1px solid rgba(255, 255, 255, 0.08)' : 'none'}
      overflow="hidden"
      transition="width 0.35s cubic-bezier(0.32, 0.72, 0, 1), border-left 0.25s ease"
    >
      <Flex
        direction="column"
        w={`${DRAWER_W}px`}
        h="100%"
        transform={open ? 'translateX(0)' : 'translateX(100%)'}
        opacity={open ? 1 : 0}
        transition="transform 0.35s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.2s ease 0.05s"
      >
        {/* Header — title, presence, call/present/close actions */}
        <Flex
          align="center"
          justify="space-between"
          px={3}
          py={2.5}
          flexShrink={0}
          borderBottom="1px solid rgba(255, 255, 255, 0.06)"
        >
          <Flex align="center" gap={2} minW={0}>
            <VscCommentDiscussion size={14} color={tokens.colors.text.secondary} />
            <Text fontSize="13px" fontWeight={600} color={tokens.colors.text.primary}>
              {t('team.chatTitle')}
            </Text>
            <Flex align="center" gap={1.5} minW={0}>
              <Box
                w="6px"
                h="6px"
                borderRadius="full"
                bg={connected ? tokens.colors.accent.greenBright : tokens.colors.text.muted}
              />
              <Text fontSize="10px" color={tokens.colors.text.muted} lineClamp={1}>
                {t('team.peersOnline').replace('{count}', String(peers.length))}
              </Text>
            </Flex>
          </Flex>
          <Flex align="center" gap={1}>
            {/* Present our screen — ONE click straight into the OS surface
                picker (screen vs window is chosen THERE; the picker is the
                platform's privacy gate for getDisplayMedia and cannot be
                skipped — a pre-menu on our side was just a redundant step). */}
            {connected && !screenPresenter && !screenSharing && (
              <IconButton
                label={t('team.screenShare')}
                dimmed={screenStarting}
                onClick={() => void startScreenShare()}
              >
                <VscDeviceCameraVideo size={14} />
              </IconButton>
            )}
            {/* Start a call — once one is active, the voice strip owns the controls. */}
            {connected && !callActive && (
              <IconButton
                label={t('team.voiceStartCall')}
                dimmed={voiceJoining}
                onClick={() => void joinVoiceCall()}
              >
                <VscCallOutgoing size={14} />
              </IconButton>
            )}
            <IconButton label={t('team.closeChat')} onClick={() => setChatOpen(false)}>
              <VscClose size={14} />
            </IconButton>
          </Flex>
        </Flex>

        {/* Voice call strip — participants + join/mute/leave. */}
        {callActive && (
          <Flex
            direction="column"
            gap={1.5}
            px={3}
            py={2}
            flexShrink={0}
            bg={tokens.colors.bg.panelAlt}
            borderBottom="1px solid rgba(255, 255, 255, 0.06)"
          >
            <Flex align="center" justify="space-between">
              <Flex align="center" gap={2} minW={0}>
                <SectionLabel>
                  {t('team.voiceTitle')} ·{' '}
                  {t('team.voiceInCallCount').replace('{count}', String(participantCount))}
                </SectionLabel>
                {inVoice && (
                  <ElapsedLabel
                    since={voiceStartedAt}
                    fontSize="10px"
                    fontFamily={tokens.fontFamily.mono}
                    color={tokens.colors.text.secondary}
                    flexShrink={0}
                  />
                )}
                {voiceCountdown !== null && (
                  <Text fontSize="10px" fontWeight="700" color={tokens.colors.accent.red} flexShrink={0}>
                    {t('team.voiceEndsIn').replace('{s}', String(voiceCountdown))}
                  </Text>
                )}
              </Flex>
              {inVoice ? (
                <Flex align="center" gap={1}>
                  <IconButton
                    label={voiceMuted ? t('team.voiceUnmute') : t('team.voiceMute')}
                    onClick={() => toggleVoiceMute()}
                  >
                    {voiceMuted ? (
                      <VscMute size={14} color={tokens.colors.accent.red} />
                    ) : (
                      <VscMic size={14} />
                    )}
                  </IconButton>
                  <Box
                    as="button"
                    fontSize="10px"
                    fontWeight="600"
                    px="8px"
                    py="3px"
                    borderRadius="5px"
                    color={tokens.colors.accent.red}
                    bg={tokens.colors.accent.redSubtle}
                    _hover={{ bg: tokens.colors.accent.redMuted }}
                    onClick={() => leaveVoiceCall()}
                  >
                    {t('team.voiceLeaveCall')}
                  </Box>
                </Flex>
              ) : (
                <Box
                  as="button"
                  fontSize="10px"
                  fontWeight="600"
                  px="8px"
                  py="3px"
                  borderRadius="5px"
                  color={tokens.colors.badge.notificationText}
                  bg={tokens.colors.accent.primary}
                  onClick={() => void joinVoiceCall()}
                >
                  {t('team.voiceJoinCall')}
                </Box>
              )}
            </Flex>
            <Flex wrap="wrap" gap={1}>
              {inVoice && (
                <VoiceChip name={t('team.voiceYou')} muted={voiceMuted} speaking={speakingSelf} />
              )}
              {voicePeers.map(([uid, p]) => (
                <VoiceChip key={uid} name={p.name} muted={p.muted} speaking={p.speaking} path={pathForUid(uid)} />
              ))}
            </Flex>
          </Flex>
        )}

        {/* Screen share strip — presenter status + watch/stop controls */}
        {(screenSharing || screenPresenter) && (
          <Flex
            align="center"
            justify="space-between"
            gap={2}
            px={3}
            py={2}
            flexShrink={0}
            bg={tokens.colors.bg.panelAlt}
            borderBottom="1px solid rgba(255, 255, 255, 0.06)"
          >
            <Flex align="center" gap={2} minW={0}>
              <VscDeviceCameraVideo
                size={13}
                color={tokens.colors.accent.red}
                style={{ flexShrink: 0 }}
              />
              <Text fontSize="11px" color={tokens.colors.text.secondary} lineClamp={1}>
                {screenSharing
                  ? t('team.screenYouArePresenting')
                  : t('team.screenPresenting').replace('{name}', screenPresenter?.name ?? '')}
              </Text>
              {!screenSharing && screenPresenter && (
                <PeerPathBadge path={pathForUid(screenPresenter.uid)} size={11} />
              )}
              <ElapsedLabel
                since={screenSince}
                fontSize="10px"
                fontFamily={tokens.fontFamily.mono}
                color={tokens.colors.text.muted}
                flexShrink={0}
              />
            </Flex>
            {screenSharing ? (
              <Box
                as="button"
                flexShrink={0}
                fontSize="10px"
                fontWeight="600"
                px="8px"
                py="3px"
                borderRadius="5px"
                color={tokens.colors.accent.red}
                bg={tokens.colors.accent.redSubtle}
                _hover={{ bg: tokens.colors.accent.redMuted }}
                onClick={() => stopScreenShare()}
              >
                {t('team.screenStop')}
              </Box>
            ) : screenWatching ? (
              <Text fontSize="10px" color={tokens.colors.text.muted} flexShrink={0}>
                {t('team.screenWatchingTag')}
              </Text>
            ) : (
              <Box
                as="button"
                flexShrink={0}
                fontSize="10px"
                fontWeight="600"
                px="8px"
                py="3px"
                borderRadius="5px"
                color={tokens.colors.badge.notificationText}
                bg={tokens.colors.accent.primary}
                onClick={() => watchPresenter()}
              >
                {t('team.screenWatch')}
              </Box>
            )}
          </Flex>
        )}

        {/* Messages */}
        <Box ref={listRef} flex={1} overflowY="auto" px={3} py={2}>
          {chat.length === 0 ? (
            <Flex direction="column" align="center" gap={2} mt={10} px={4}>
              <VscCommentDiscussion size={22} color={tokens.colors.text.muted} />
              <Text fontSize="11px" color={tokens.colors.text.muted} textAlign="center">
                {t('team.chatEmpty')}
              </Text>
            </Flex>
          ) : (
            <ChatMessages chat={chat} selfUid={selfUid} selfLabel={t('team.voiceYou')} />
          )}
        </Box>

        {/* Your own live-preview sharing status + explicit stop button */}
        {sharing && (
          <Flex
            align="center"
            justify="space-between"
            flexShrink={0}
            px={3}
            py={2}
            gap={2}
            borderTop="1px solid rgba(255, 255, 255, 0.06)"
          >
            <Flex align="center" gap={2} minW={0}>
              <Box w="6px" h="6px" borderRadius="full" bg={tokens.colors.accent.greenBright} flexShrink={0} />
              <Text fontSize="11px" color={tokens.colors.text.secondary} lineClamp={1}>
                {t('team.youAreSharing')}
              </Text>
            </Flex>
            <Box
              as="button"
              flexShrink={0}
              fontSize="10px"
              fontWeight="600"
              px="8px"
              py="3px"
              borderRadius="5px"
              color={tokens.colors.accent.red}
              bg={tokens.colors.accent.redSubtle}
              _hover={{ bg: tokens.colors.accent.redMuted }}
              onClick={() => stopLivePreview()}
            >
              {t('team.stopLivePreview')}
            </Box>
          </Flex>
        )}

        {/* Typing indicator */}
        {typingLabel && (
          <Text
            flexShrink={0}
            px={3}
            pb={1}
            fontSize="10px"
            fontStyle="italic"
            color={tokens.colors.text.muted}
            lineClamp={1}
          >
            {typingLabel}
          </Text>
        )}

        {/* Composer — rounded field with the send action inside */}
        <Flex
          align="flex-end"
          gap={1}
          mx={2}
          mb={2}
          mt={1}
          px={2}
          py={1}
          flexShrink={0}
          bg={tokens.colors.bg.panelAlt}
          border={`1px solid ${tokens.colors.border.default}`}
          borderRadius="8px"
          transition={`border-color ${tokens.transition.fast}`}
          _focusWithin={{ borderColor: tokens.colors.accent.primary }}
        >
          <Textarea
            ref={inputRef}
            size="sm"
            rows={1}
            value={draft}
            placeholder={t('team.chatPlaceholder')}
            // Code-oriented chat: no browser autocomplete / autocorrect /
            // autocapitalize / spellcheck mangling identifiers, paths or commands.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value)
              notifyTyping(e.target.value.trim().length > 0)
              autoGrow()
            }}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline (multi-line message).
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            bg="transparent"
            border="none"
            outline="none"
            _focus={{ boxShadow: 'none' }}
            fontSize="12px"
            resize="none"
            minH="28px"
            maxH="120px"
            py="5px"
            px={1}
          />
          <IconButton label={t('team.sendMessage')} onClick={submit} dimmed={!draft.trim()}>
            <VscSend size={15} color={draft.trim() ? tokens.colors.accent.primary : undefined} />
          </IconButton>
        </Flex>
      </Flex>
    </Flex>
  )
}
