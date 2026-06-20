import { useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { useTranslation } from '@/i18n'
import { tokens } from '@/theme/tokens'
import { useAuthStore } from '@/stores/authStore'
import { canShareCode, useCollabStore, type LivePreview } from '@/stores/collabStore'
import { sendChatMessage, stopLivePreview } from '@/services/collab/collabSessionService'
import { openPreview } from '@/services/collab/previewViewerService'
import { useTeamTyping } from '@/hooks/useTeamTyping'
import type { ChatMessage } from '@/services/collab/collabChat'

// Terminal-style team chat — a side panel (mounted alongside the PTY
// TerminalPanel in TerminalView) in the mIRC/Discord idiom: a single `#`
// channel, `HH:MM <nick> message` lines, monospace, flat + sharp, a single
// purple accent, hard-step motion only (refined-terminal contract). Driven by
// the same collab store as the floating chat used in Chat mode; the two never
// render at once (Chat mode = MainLayout, Terminal mode = WelcomeScreen).

const PANEL_WIDTH = 360

/** Deterministic per-nick color from the IRC-ish palette (stable per uid). */
const NICK_PALETTE = [
  tokens.colors.terminal.brightCyan,
  tokens.colors.terminal.brightGreen,
  tokens.colors.terminal.brightYellow,
  tokens.colors.terminal.brightMagenta,
  tokens.colors.terminal.brightBlue,
  tokens.colors.terminal.brightRed,
]
function nickColor(uid: string): string {
  let h = 0
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0
  return NICK_PALETTE[h % NICK_PALETTE.length]
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function TerminalTeamChatPanel() {
  const t = useTranslation()
  const open = useCollabStore((s) => s.chatOpen)
  const chat = useCollabStore((s) => s.chat)
  const peers = useCollabStore((s) => s.peers)
  const connected = useCollabStore((s) => s.connected)
  const livePreviews = useCollabStore((s) => s.livePreviews)
  const sharing = useCollabStore((s) => s.sharingPreview)
  const setChatOpen = useCollabStore((s) => s.setChatOpen)
  const selfUid = useAuthStore((s) => s.user?.uid)
  const { notifyTyping, stopTyping, typingLabel } = useTeamTyping()
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [chat, open, livePreviews, sharing, typingLabel])

  // Grow the composer to fit its content (capped by maxHeight in the style).
  const autoGrow = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  // Render nothing unless this is a team member with the panel toggled open.
  if (!open || !canShareCode()) return null

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    sendChatMessage(text)
    setDraft('')
    stopTyping()
    // Collapse the grown composer back to one row after sending.
    if (inputRef.current) inputRef.current.style.height = 'auto'
  }

  const openOffer = (lp: LivePreview) => void openPreview(lp.peerId, lp.name)

  return (
    <Flex
      direction="column"
      w={`${PANEL_WIDTH}px`}
      flexShrink={0}
      h="100%"
      bg={tokens.colors.terminal.background}
      borderLeft={`1px solid ${tokens.colors.terminal.chromeHairline}`}
      fontFamily={tokens.fontFamily.mono}
    >
      {/* Header — channel + presence. Height matches TerminalTitleBar
          (py 11px / minH 38px) so the two headers line up across the divider. */}
      <Flex
        align="center"
        justify="space-between"
        flexShrink={0}
        minH="38px"
        px={3}
        py="11px"
        bg={tokens.colors.terminal.titlebarBg}
        borderBottom={`1px solid ${tokens.colors.terminal.chromeHairline}`}
        data-ui-chrome
      >
        <Flex align="center" gap={2} minW={0}>
          <Text fontSize="12px" color={tokens.colors.accent.purple} fontWeight="600">
            #{t('team.terminalChatHeader')}
          </Text>
          <Box
            w="6px"
            h="6px"
            borderRadius="full"
            bg={connected ? tokens.colors.terminal.brightGreen : tokens.colors.terminal.brightBlack}
            flexShrink={0}
          />
          <Text fontSize="10px" color={tokens.colors.terminal.brightBlack}>
            {t('team.peersOnline').replace('{count}', String(peers.length))}
          </Text>
        </Flex>
        <Box
          as="button"
          aria-label={t('team.closeChat')}
          color={tokens.colors.terminal.brightBlack}
          _hover={{ color: tokens.colors.terminal.foreground }}
          fontSize="13px"
          lineHeight="1"
          onClick={() => setChatOpen(false)}
        >
          ✕
        </Box>
      </Flex>

      {/* Transcript */}
      <Box
        ref={listRef}
        flex={1}
        minH={0}
        overflowY="auto"
        px={3}
        py={2}
        css={{
          '&::-webkit-scrollbar': { width: '4px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.08)' },
        }}
      >
        {chat.length === 0 ? (
          <Text fontSize="11px" color={tokens.colors.terminal.brightBlack} mt={2}>
            {t('team.chatEmpty')}
          </Text>
        ) : (
          chat.map((m: ChatMessage) => {
            const mine = m.uid === selfUid
            return (
              <Box key={m.id} mb="3px" fontSize="12px" lineHeight="1.5" wordBreak="break-word">
                <Text as="span" color={tokens.colors.terminal.brightBlack}>
                  {hhmm(m.ts)}{' '}
                </Text>
                <Text
                  as="span"
                  color={mine ? tokens.colors.accent.purple : nickColor(m.uid)}
                  fontWeight="600"
                >
                  {'<'}{m.name}{'>'}{' '}
                </Text>
                <Text as="span" color={tokens.colors.terminal.foreground} whiteSpace="pre-wrap">
                  {m.text}
                </Text>
              </Box>
            )
          })
        )}
      </Box>

      {/* Incoming live previews — clickable system lines */}
      {livePreviews.length > 0 && (
        <Box
          flexShrink={0}
          borderTop={`1px solid ${tokens.colors.terminal.chromeHairline}`}
          px={3}
          py={1.5}
        >
          {livePreviews.map((lp) => (
            <Flex
              key={lp.peerId}
              as="button"
              w="100%"
              align="center"
              gap={2}
              py="3px"
              fontSize="11px"
              color={tokens.colors.accent.purple}
              _hover={{ color: tokens.colors.terminal.foreground }}
              onClick={() => openOffer(lp)}
              title={t('team.openPreview')}
            >
              <Text as="span" flexShrink={0}>▸</Text>
              <Text as="span" lineClamp={1} textAlign="left" flex={1}>
                {t('team.previewOffered').replace('{name}', lp.name)}
              </Text>
              <Text as="span" flexShrink={0} color={tokens.colors.terminal.brightBlack}>
                [{t('team.openPreview').toLowerCase()}]
              </Text>
            </Flex>
          ))}
        </Box>
      )}

      {/* Your own sharing status */}
      {sharing && (
        <Flex
          align="center"
          justify="space-between"
          flexShrink={0}
          px={3}
          py={1.5}
          borderTop={`1px solid ${tokens.colors.terminal.chromeHairline}`}
          fontSize="11px"
        >
          <Flex align="center" gap={2} color={tokens.colors.terminal.brightGreen}>
            <Text as="span">◉</Text>
            <Text as="span">{t('team.youAreSharing')}</Text>
          </Flex>
          <Box
            as="button"
            flexShrink={0}
            color={tokens.colors.terminal.brightBlack}
            _hover={{ color: tokens.colors.terminal.brightRed }}
            onClick={() => stopLivePreview()}
            title={t('team.stopLivePreview')}
          >
            [{t('team.stopLivePreview').toLowerCase()}]
          </Box>
        </Flex>
      )}

      {/* Typing indicator — mIRC-style dim line above the prompt */}
      {typingLabel && (
        <Text
          flexShrink={0}
          px={3}
          pb={1}
          fontSize="11px"
          color={tokens.colors.terminal.brightBlack}
          lineClamp={1}
        >
          {typingLabel}
        </Text>
      )}

      {/* Composer — `>` prompt, Enter sends. Padding matches the main
          CmdModePromptInput (px3/py3) so the two input rows align. */}
      <Flex
        align="center"
        gap={2}
        flexShrink={0}
        px={3}
        py={3}
        borderTop={`1px solid ${tokens.colors.terminal.chromeHairline}`}
      >
        <Text fontSize="13px" color={tokens.colors.accent.purple} flexShrink={0} lineHeight="1.5" mt="1px">
          ›
        </Text>
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          placeholder={t('team.chatPlaceholder')}
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
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            overflowY: 'auto',
            maxHeight: '120px',
            lineHeight: '1.5',
            color: tokens.colors.terminal.foreground,
            fontFamily: tokens.fontFamily.mono,
            fontSize: '12px',
            minWidth: 0,
          }}
        />
      </Flex>
    </Flex>
  )
}
