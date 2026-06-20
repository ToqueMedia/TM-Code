import { useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { useTranslation } from '@/i18n'
import { tokens } from '@/theme/tokens'
import { canShareCode, useCollabStore } from '@/stores/collabStore'

/**
 * Terminal-style unread-team-chat banner. Sits just above the prompt (chrome,
 * not scrollback) while the team chat panel is CLOSED and there are unread
 * messages — so a teammate's message is never silent. Clicking opens the chat
 * (which clears the unread count). Briefly flashes the accent when a new message
 * lands, mIRC-bell style.
 */
export function TerminalChatNotification() {
  const t = useTranslation()
  const chatOpen = useCollabStore((s) => s.chatOpen)
  const chatUnread = useCollabStore((s) => s.chatUnread)
  const chat = useCollabStore((s) => s.chat)
  const setChatOpen = useCollabStore((s) => s.setChatOpen)

  // Flash the bar each time the unread count grows.
  const [flash, setFlash] = useState(false)
  const prevUnread = useRef(chatUnread)
  useEffect(() => {
    if (chatUnread > prevUnread.current) {
      setFlash(true)
      const id = setTimeout(() => setFlash(false), 450)
      prevUnread.current = chatUnread
      return () => clearTimeout(id)
    }
    prevUnread.current = chatUnread
  }, [chatUnread])

  if (chatOpen || chatUnread === 0 || !canShareCode()) return null

  const last = chat[chat.length - 1]
  const preview = last ? `${last.name}: ${last.text}` : ''

  return (
    <Box flexShrink={0} px={3} py="6px" data-ui-chrome>
      <Flex
        as="button"
        w="100%"
        align="center"
        gap={2}
        px={2.5}
        py="6px"
        textAlign="left"
        borderRadius={tokens.radius.sm}
        bg={flash ? 'rgba(163,113,247,0.22)' : 'rgba(163,113,247,0.10)'}
        border={`1px solid ${flash ? tokens.colors.accent.purple : 'rgba(163,113,247,0.30)'}`}
        color={tokens.colors.terminal.foreground}
        fontFamily={tokens.fontFamily.mono}
        transition="background 0.2s, border-color 0.2s"
        _hover={{ bg: 'rgba(163,113,247,0.18)' }}
        onClick={() => setChatOpen(true)}
      >
        <Text as="span" flexShrink={0} color={tokens.colors.accent.purple} fontWeight="700">
          ✉
        </Text>
        <Text
          as="span"
          flexShrink={0}
          fontSize="11px"
          fontWeight="700"
          color={tokens.colors.accent.purple}
        >
          {t('team.newTeamMessages').replace('{count}', String(chatUnread))}
        </Text>
        {preview && (
          <Text
            as="span"
            flex={1}
            minW={0}
            fontSize="11px"
            color={tokens.colors.terminal.brightBlack}
            lineClamp={1}
          >
            {preview}
          </Text>
        )}
        <Text as="span" flexShrink={0} fontSize="10px" color={tokens.colors.terminal.brightBlack}>
          [{t('team.openChat').toLowerCase()}]
        </Text>
      </Flex>
    </Box>
  )
}
