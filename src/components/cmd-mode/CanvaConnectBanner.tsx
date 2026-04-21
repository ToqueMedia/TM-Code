import { memo } from 'react'
import { Flex, Text } from '@chakra-ui/react'
import { useMcpStore } from '../../stores/mcpStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n/useTranslation'
import { isCanvaConnected } from '../../utils/canvaMcp'
import MCPService from '../../services/mcp/mcpService'
import { tokens } from '@/theme/tokens'

/**
 * CMD-mode banner advertising the optional Canva MCP integration.
 * Hidden when:
 *   - Canva MCP is connected (auto-detected via the store), OR
 *   - the user dismissed it (persisted across sessions; can re-run /canva-connect anytime)
 */
export const CanvaConnectBanner = memo(function CanvaConnectBanner() {
  const t = useTranslation()
  const servers = useMcpStore(s => s.servers)
  const dismissed = useSettingsStore(s => s.cmdBannerDismissed.canva ?? false)
  const dismiss = useSettingsStore(s => s.dismissCmdBanner)

  if (dismissed) return null
  // Pass the URL lookup so detection matches by canonical URL, not by a name
  // that another MCP entry could collide with.
  const getUrl = (name: string) => MCPService.getInstance().getServerUrl(name)
  if (isCanvaConnected(servers, getUrl)) return null

  // Translation strings use {cmd} placeholder so the slash command renders bold inline.
  const template = t('cmd.canva.banner.text')
  const [before, after] = template.split('{cmd}')

  return (
    <Flex
      align="center"
      gap={2}
      px={3}
      py="5px"
      bg="rgba(254, 16, 99, 0.06)"
      borderBottom="1px solid rgba(254, 16, 99, 0.18)"
      flexShrink={0}
      data-tauri-drag-region
    >
      <Text
        fontSize="11px"
        color={tokens.colors.text.link}
        fontFamily={tokens.fontFamily.mono}
        fontWeight="700"
      >
        ⟡
      </Text>
      <Text
        fontSize="11px"
        color={tokens.colors.text.link}
        fontFamily={tokens.fontFamily.mono}
        opacity={0.95}
        flex="1"
      >
        {before}
        <Text as="span" mx="4px" fontWeight="700" color={tokens.colors.text.link}>
          /canva-connect
        </Text>
        {after}
      </Text>
      <button
        type="button"
        onClick={() => dismiss('canva')}
        aria-label={t('cmd.canva.banner.dismiss')}
        title={t('cmd.canva.banner.dismiss')}
        style={{
          padding: '1px 6px',
          fontSize: '11px',
          fontFamily: tokens.fontFamily.mono,
          color: tokens.colors.text.muted,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          borderRadius: '3px',
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </Flex>
  )
})
