import { useEffect, useRef, useState } from 'react'
import { Box, Flex, Text, Textarea } from '@chakra-ui/react'
import { VscClose, VscSend } from 'react-icons/vsc'
import { useTranslation } from '@/i18n'
import { tokens } from '@/theme/tokens'
import { useAuthStore } from '@/stores/authStore'
import { useCollabStore } from '@/stores/collabStore'
import { sendChatMessage, stopLivePreview } from '@/services/collab/collabSessionService'
import { useTeamTyping } from '@/hooks/useTeamTyping'

/**
 * Floating ephemeral team-chat panel. Messages travel P2P over the WebRTC
 * control channel (DTLS, never a server); optional local history lives under
 * .toquemedia/collab/. Mounted once in MainLayout, shown when `chatOpen`.
 */
export function TeamChatPanel() {
  const t = useTranslation()
  const open = useCollabStore((s) => s.chatOpen)
  const chat = useCollabStore((s) => s.chat)
  const peers = useCollabStore((s) => s.peers)
  const connected = useCollabStore((s) => s.connected)
  const sharing = useCollabStore((s) => s.sharingPreview)
  const setChatOpen = useCollabStore((s) => s.setChatOpen)
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
