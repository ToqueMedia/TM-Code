import { useState } from 'react'
import { Box, Button, Flex, Text } from '@chakra-ui/react'
import { VscBroadcast, VscComment, VscGlobe } from 'react-icons/vsc'
import { useTranslation } from '@/i18n'
import { tokens } from '@/theme/tokens'
import { canShareCode, useCollabStore, type LivePreview } from '@/stores/collabStore'
import { useProjectStore } from '@/stores/projectStore'
import { stopLivePreview } from '@/services/collab/collabSessionService'
import { startAndShareLivePreview } from '@/services/collab/livePreviewHost'
import { openPreview } from '@/services/collab/previewViewerService'

/**
 * Team-collaboration header controls (shared by the Source-Control panel AND
 * the Chat-view header — see `ChatView`):
 *   - Live Preview — one click starts a dedicated dev server on port 7773
 *     (headless) and shares it, so teammates can open + test the running app
 *     from their machine, P2P. No need to start a dev server by hand.
 *   - Chat — toggles the floating TeamChatPanel; carries the online-teammate
 *     count (green dot + number) and the unread badge.
 *   - Incoming previews — teammates currently sharing; open theirs in a window.
 * Only rendered for team members (`teamMemberOf`).
 *
 * `compact` (Source-Control panel) renders icon-only chips; the default
 * (Chat header) adds text labels now that there's room for them.
 */
export function CollabShareControls({ compact = false }: { compact?: boolean }) {
  const t = useTranslation()
  const connected = useCollabStore((s) => s.connected)
  const peers = useCollabStore((s) => s.peers)
  const chatOpen = useCollabStore((s) => s.chatOpen)
  const chatUnread = useCollabStore((s) => s.chatUnread)
  const setChatOpen = useCollabStore((s) => s.setChatOpen)
  const livePreviews = useCollabStore((s) => s.livePreviews)
  const sharing = useCollabStore((s) => s.sharingPreview)
  const starting = useCollabStore((s) => s.startingPreview)
  const [shareOpen, setShareOpen] = useState(false)
  const [offersOpen, setOffersOpen] = useState(false)

  if (!canShareCode()) return null

  // Live Preview click: while live → open the stop dropdown; while idle → start
  // the dedicated 7773 server and share (handled by livePreviewHost).
  const onLivePreviewClick = () => {
    if (starting) return
    if (sharing) {
      setShareOpen((v) => !v)
      return
    }
    const projectPath = useProjectStore.getState().currentProject?.path ?? null
    void startAndShareLivePreview(projectPath)
  }

  const open = (lp: LivePreview) => {
    setOffersOpen(false)
    void openPreview(lp.peerId, lp.name)
  }

  return (
    <Flex align="center" gap={1} position="relative" flexShrink={0}>
      {/* Live Preview — starts + shares on click; shows a stop dropdown while
          live. While sharing it carries a pulsing LIVE badge so the user always
          sees that their preview is being broadcast. */}
      <Chip
        icon={<VscBroadcast size={13} />}
        label={compact ? undefined : t('team.livePreviewLabel')}
        title={
          starting
            ? t('team.startingPreview')
            : sharing
              ? t('team.liveActive')
              : t('team.shareLivePreview')
        }
        active={sharing || starting}
        busy={starting}
        live={sharing && !starting}
        liveLabel={t('team.liveBadge')}
        onClick={onLivePreviewClick}
      />

      {/* Chat — with merged online-presence count + unread badge */}
      <Chip
        icon={<VscComment size={13} />}
        label={compact ? undefined : t('team.chatLabel')}
        title={t('team.chatTitle')}
        active={chatOpen}
        onClick={() => setChatOpen(!chatOpen)}
        trailing={
          <Flex align="center" gap="3px">
            <Box
              w="6px"
              h="6px"
              borderRadius="full"
              bg={connected ? tokens.colors.accent.greenBright : tokens.colors.text.disabled}
            />
            <Text fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.text.muted}>
              {peers.length}
            </Text>
          </Flex>
        }
        badge={chatUnread > 0 ? chatUnread : undefined}
      />

      {/* Incoming live previews */}
      {livePreviews.length > 0 && (
        <Chip
          icon={<VscGlobe size={13} />}
          label={compact ? undefined : t('team.incomingPreviews')}
          title={t('team.incomingPreviews')}
          onClick={() => setOffersOpen((v) => !v)}
          badge={livePreviews.length}
        />
      )}

      {/* Live Preview stop dropdown (only while sharing) */}
      {shareOpen && sharing && (
        <Dropdown>
          <Flex align="center" gap={2} mb={2}>
            <Box w="6px" h="6px" borderRadius="full" bg={tokens.colors.accent.greenBright} flexShrink={0} />
            <Text fontSize="11px" color={tokens.colors.text.secondary}>
              {t('team.youAreSharing')}
            </Text>
          </Flex>
          <Button
            size="xs"
            w="100%"
            colorPalette="red"
            onClick={() => {
              stopLivePreview()
              setShareOpen(false)
            }}
          >
            {t('team.stopLivePreview')}
          </Button>
        </Dropdown>
      )}

      {/* Incoming previews dropdown */}
      {offersOpen && livePreviews.length > 0 && (
        <Dropdown title={t('team.incomingPreviews')}>
          {livePreviews.map((lp) => (
            <Flex
              key={lp.peerId}
              align="center"
              gap={2.5}
              px={2}
              py={2}
              borderRadius="6px"
              cursor="pointer"
              transition={`background ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              onClick={() => open(lp)}
            >
              <Avatar name={lp.name} live />
              <Box minW={0} flex={1}>
                <Text fontSize="12px" fontWeight="500" color={tokens.colors.text.primary} lineClamp={1}>
                  {displayName(lp.name)}
                </Text>
                <Text fontSize="10px" color={tokens.colors.text.muted} lineClamp={1}>
                  {lp.note || lp.name}
                </Text>
              </Box>
              <Button
                size="2xs"
                colorPalette="purple"
                variant="solid"
                flexShrink={0}
                onClick={(e) => {
                  e.stopPropagation()
                  open(lp)
                }}
              >
                {t('team.openPreview')}
              </Button>
            </Flex>
          ))}
        </Dropdown>
      )}
    </Flex>
  )
}

/** A teammate's display name — strips the domain off an email so the UI shows
 *  "jane" instead of "jane@acme.com" (the offer falls back to email when the
 *  account has no display name set). */
function displayName(name: string): string {
  const at = name.indexOf('@')
  return at > 0 ? name.slice(0, at) : name
}

/** Small monogram avatar — first initial on a soft accent disc, with an
 *  optional pulsing "live" ring for teammates currently sharing. */
function Avatar({ name, live }: { name: string; live?: boolean }) {
  const initial = (displayName(name).trim()[0] || '?').toUpperCase()
  return (
    <Flex
      align="center"
      justify="center"
      flexShrink={0}
      w="26px"
      h="26px"
      borderRadius="full"
      bg={tokens.colors.accent.primarySubtle}
      border={`1px solid ${live ? tokens.colors.accent.primary : tokens.colors.accent.primaryMuted}`}
      color={tokens.colors.accent.primary}
      fontSize="11px"
      fontWeight="700"
      fontFamily={tokens.fontFamily.mono}
      position="relative"
    >
      {initial}
      {live && (
        <Box
          position="absolute"
          bottom="-1px"
          right="-1px"
          w="8px"
          h="8px"
          borderRadius="full"
          bg={tokens.colors.accent.greenBright}
          border={`1.5px solid ${tokens.colors.bg.overlay}`}
        />
      )}
    </Flex>
  )
}

/** A header chip: icon (or spinner) + optional label + trailing content + badge. */
function Chip({
  icon,
  label,
  title,
  active,
  busy,
  live,
  liveLabel,
  onClick,
  trailing,
  badge,
}: {
  icon: React.ReactNode
  label?: string
  title: string
  active?: boolean
  busy?: boolean
  /** Render a pulsing "live" badge (used while actively sharing). */
  live?: boolean
  liveLabel?: string
  onClick: () => void
  trailing?: React.ReactNode
  badge?: number
}) {
  return (
    <Flex
      as="button"
      align="center"
      gap="5px"
      h="24px"
      px="7px"
      flexShrink={0}
      borderRadius="6px"
      position="relative"
      color={active ? tokens.colors.accent.primary : tokens.colors.text.secondary}
      bg={live ? tokens.colors.accent.primarySubtle : undefined}
      border={live ? `1px solid ${tokens.colors.accent.primaryMuted}` : '1px solid transparent'}
      transition={`all ${tokens.transition.fast}`}
      _hover={{ bg: live ? tokens.colors.accent.primarySubtle : tokens.colors.bg.hoverSubtle, color: active ? tokens.colors.accent.primary : tokens.colors.text.primary }}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      <Box display="flex" alignItems="center" flexShrink={0} position="relative">
        {busy ? (
          <Box
            w="12px"
            h="12px"
            borderRadius="full"
            border={`2px solid ${tokens.colors.accent.primaryMuted}`}
            borderTopColor={tokens.colors.accent.primary}
            css={{ animation: 'collab-spin 0.7s linear infinite', '@keyframes collab-spin': { to: { transform: 'rotate(360deg)' } } }}
          />
        ) : (
          icon
        )}
        {/* Pulsing dot anchored to the icon while live. */}
        {live && (
          <Box
            position="absolute"
            top="-3px"
            right="-4px"
            w="6px"
            h="6px"
            borderRadius="full"
            bg={tokens.colors.accent.primary}
            css={{ animation: 'collab-pulse 1.2s ease-in-out infinite', '@keyframes collab-pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.25 } } }}
          />
        )}
      </Box>
      {live && liveLabel ? (
        <Text
          data-chat-toolbar-secondary-label
          fontSize="9px"
          fontWeight="700"
          letterSpacing="0.06em"
          fontFamily={tokens.fontFamily.mono}
          color={tokens.colors.accent.primary}
          whiteSpace="nowrap"
        >
          {liveLabel}
        </Text>
      ) : (
        label && (
          <Text data-chat-toolbar-secondary-label fontSize="11px" fontWeight="500" whiteSpace="nowrap">
            {label}
          </Text>
        )
      )}
      {trailing}
      {badge !== undefined && (
        <Box
          as="span"
          position="absolute"
          top="-3px"
          right="-3px"
          fontSize="8px"
          fontWeight="700"
          fontFamily={tokens.fontFamily.mono}
          color={tokens.colors.badge.notificationText}
          bg={tokens.colors.accent.primary}
          borderRadius="full"
          px="3px"
          lineHeight="12px"
          minW="12px"
          textAlign="center"
        >
          {badge}
        </Box>
      )}
    </Flex>
  )
}

function Dropdown({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <Box
      position="absolute"
      top="30px"
      right="0"
      zIndex={40}
      minW="260px"
      bg={tokens.colors.bg.overlay}
      border={`1px solid ${tokens.colors.border.default}`}
      borderRadius="8px"
      boxShadow="0 12px 32px rgba(0,0,0,0.5)"
      p={1.5}
      css={{
        animation: 'collab-dropdown-in 0.12s ease-out',
        '@keyframes collab-dropdown-in': {
          from: { opacity: 0, transform: 'translateY(-4px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
      }}
    >
      {title && (
        <Text
          px={2}
          pt={1}
          pb={1.5}
          fontSize="9px"
          fontWeight="700"
          letterSpacing="0.06em"
          textTransform="uppercase"
          color={tokens.colors.text.muted}
        >
          {title}
        </Text>
      )}
      {children}
    </Box>
  )
}
