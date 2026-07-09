import { useEffect, useRef, useState } from 'react'
import { Box, Flex, Text, Textarea } from '@chakra-ui/react'
import {
  VscCallOutgoing,
  VscClose,
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

/** One participant pill in the voice bar: mic state + speaking highlight. */
function VoiceChip({ name, muted, speaking }: { name: string; muted: boolean; speaking: boolean }) {
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
    </Flex>
  )
}

/**
 * Floating ephemeral team-chat panel. Messages travel P2P over the WebRTC
 * control channel (DTLS, never a server); optional local history lives in
 * app-managed project state. Mounted once in MainLayout, shown when `chatOpen`.
 */
export function TeamChatPanel() {
  const t = useTranslation()
  const open = useCollabStore((s) => s.chatOpen)
  const chat = useCollabStore((s) => s.chat)
  const peers = useCollabStore((s) => s.peers)
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

  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [chat, open, typingLabel])

  // Grow the composer to fit its content (capped by maxH on the Textarea).
  const autoGrow = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  if (!open) return null

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

  return (
    <Box
      position="fixed"
      bottom="48px"
      right="16px"
      zIndex={50}
      w="320px"
      h="420px"
      display="flex"
      flexDirection="column"
      bg={tokens.colors.bg.overlay}
      border={`1px solid ${tokens.colors.border.default}`}
      borderRadius="8px"
      boxShadow="0 12px 40px rgba(0,0,0,0.45)"
      overflow="hidden"
    >
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        h="36px"
        flexShrink={0}
        bg={tokens.colors.bg.glass}
        borderBottom={`1px solid ${tokens.colors.border.default}`}
      >
        <Flex align="center" gap={2}>
          <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary}>
            {t('team.chatTitle')}
          </Text>
          <Box
            w="6px"
            h="6px"
            borderRadius="full"
            bg={connected ? '#3fb950' : tokens.colors.text.muted}
          />
          <Text fontSize="10px" color={tokens.colors.text.muted}>
            {t('team.peersOnline').replace('{count}', String(peers.length))}
          </Text>
        </Flex>
        <Flex align="center" gap={2}>
          {/* Present our screen — hidden while a presentation is running. */}
          {connected && !screenPresenter && !screenSharing && (
            <Box
              as="button"
              aria-label={t('team.screenShare')}
              title={t('team.screenShare')}
              color={tokens.colors.text.muted}
              opacity={screenStarting ? 0.5 : 1}
              _hover={{ color: tokens.colors.text.primary }}
              onClick={() => void startScreenShare()}
            >
              <VscDeviceCameraVideo size={14} />
            </Box>
          )}
          {/* Start a call — once one is active, the voice bar owns the controls. */}
          {connected && !callActive && (
            <Box
              as="button"
              aria-label={t('team.voiceStartCall')}
              title={t('team.voiceStartCall')}
              color={tokens.colors.text.muted}
              opacity={voiceJoining ? 0.5 : 1}
              _hover={{ color: tokens.colors.text.primary }}
              onClick={() => void joinVoiceCall()}
            >
              <VscCallOutgoing size={14} />
            </Box>
          )}
          <Box
            as="button"
            aria-label={t('team.closeChat')}
            color={tokens.colors.text.muted}
            _hover={{ color: tokens.colors.text.primary }}
            onClick={() => setChatOpen(false)}
          >
            <VscClose size={15} />
          </Box>
        </Flex>
      </Flex>

      {/* Voice call bar — participants + join/mute/leave. The call itself keeps
          running with the panel closed; this is just its control surface. */}
      {callActive && (
        <Flex
          direction="column"
          gap={1.5}
          px={3}
          py={2}
          flexShrink={0}
          bg={tokens.colors.bg.glass}
          borderBottom={`1px solid ${tokens.colors.border.default}`}
        >
          <Flex align="center" justify="space-between">
            <Flex align="center" gap={2} minW={0}>
              <Text fontSize="10px" fontWeight="600" color={tokens.colors.text.muted}>
                {t('team.voiceTitle')} ·{' '}
                {t('team.voiceInCallCount').replace('{count}', String(participantCount))}
              </Text>
              {voiceCountdown !== null && (
                <Text fontSize="10px" fontWeight="700" color={tokens.colors.accent.red} flexShrink={0}>
                  {t('team.voiceEndsIn').replace('{s}', String(voiceCountdown))}
                </Text>
              )}
            </Flex>
            {inVoice ? (
              <Flex align="center" gap={2}>
                <Box
                  as="button"
                  aria-label={voiceMuted ? t('team.voiceUnmute') : t('team.voiceMute')}
                  title={voiceMuted ? t('team.voiceUnmute') : t('team.voiceMute')}
                  color={voiceMuted ? tokens.colors.accent.red : tokens.colors.text.muted}
                  _hover={{ color: tokens.colors.text.primary }}
                  onClick={() => toggleVoiceMute()}
                >
                  {voiceMuted ? <VscMute size={14} /> : <VscMic size={14} />}
                </Box>
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
                opacity={voiceJoining ? 0.6 : 1}
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
              <VoiceChip key={uid} name={p.name} muted={p.muted} speaking={p.speaking} />
            ))}
          </Flex>
        </Flex>
      )}

      {/* Screen share — presenter status + watch/stop controls */}
      {(screenSharing || screenPresenter) && (
        <Flex
          align="center"
          justify="space-between"
          gap={2}
          px={3}
          py={2}
          flexShrink={0}
          borderBottom={`1px solid ${tokens.colors.border.default}`}
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
          <Text fontSize="11px" color={tokens.colors.text.muted} textAlign="center" mt={6}>
            {t('team.chatEmpty')}
          </Text>
        ) : (
          chat.map((m) => {
            const mine = m.uid === selfUid
            return (
              <Flex key={m.id} direction="column" align={mine ? 'flex-end' : 'flex-start'} mb={2}>
                {!mine && (
                  <Text fontSize="9px" color={tokens.colors.text.muted} mb="2px">
                    {m.name}
                  </Text>
                )}
                <Box
                  maxW="80%"
                  px={2.5}
                  py={1.5}
                  borderRadius="8px"
                  bg={mine ? tokens.colors.accent.primary : tokens.colors.bg.panelAlt}
                  color={mine ? tokens.colors.badge.notificationText : tokens.colors.text.primary}
                >
                  <Text fontSize="12px" whiteSpace="pre-wrap" wordBreak="break-word">
                    {m.text}
                  </Text>
                </Box>
              </Flex>
            )
          })
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
          borderTop={`1px solid ${tokens.colors.border.default}`}
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

      {/* Composer */}
      <Flex
        align="center"
        gap={2}
        px={2}
        py={2}
        flexShrink={0}
        borderTop={`1px solid ${tokens.colors.border.default}`}
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
          bg={tokens.colors.bg.panelAlt}
          border={`1px solid ${tokens.colors.border.default}`}
          fontSize="12px"
          resize="none"
          minH="32px"
          maxH="120px"
          py="6px"
        />
        <Box
          as="button"
          aria-label={t('team.sendMessage')}
          color={draft.trim() ? tokens.colors.accent.primary : tokens.colors.text.muted}
          onClick={submit}
        >
          <VscSend size={16} />
        </Box>
      </Flex>
    </Box>
  )
}
