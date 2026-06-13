import { memo } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import type { Attachment } from '../../types/chat'

interface CmdAttachmentBarProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
  showImageWarning: boolean
}

// Single-color text glyph per attachment type (no multicolor SVG pictograms).
const typeGlyphs: Record<Attachment['type'], string> = {
  file: '▪',
  folder: '▸',
  image: '▪',
}

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function CmdAttachmentBar({ attachments, onRemove, showImageWarning }: CmdAttachmentBarProps) {
  // Imagens NÃO renderizam chip no terminal: o token `[Image #N]` no input É
  // a representação visível, e apagá-lo remove a imagem do envio (prune por
  // pasteMarker em useCmdPromptLogic ~l.680). O chip duplicava a informação
  // e pesava a UI (pedido do user 2026-06-12) — a imagem segue na mensagem
  // na mesma, só não aparece. Ficheiros/pastas mantêm chip porque não têm
  // token no texto (o X do chip é a única forma de os remover).
  const visibleAttachments = attachments.filter(att => att.type !== 'image')
  const hasImages = attachments.length > visibleAttachments.length
  if (visibleAttachments.length === 0 && !(showImageWarning && hasImages)) return null

  return (
    <Box
      px={3}
      pt={2}
      pb={1}
      borderTop="1px solid rgba(255, 255, 255, 0.04)"
    >
      {/* Billing warning — flat warning LINE in terminal yellow (no rounded
          card / orange tint). Upgrade CTA demoted to a bracketed text control. */}
      {showImageWarning && (
        <Flex
          align="baseline"
          gap={2}
          mb={2}
          fontFamily={tokens.fontFamily.mono}
        >
          <Text
            fontSize="11px"
            color={tokens.colors.terminal.yellow}
            flex="1"
            lineHeight="1.4"
          >
            {'! '}{t('terminalMode.imageNotSupported')}
          </Text>
          <Text
            as="button"
            fontSize="11px"
            color={tokens.colors.accent.purple}
            fontWeight="600"
            flexShrink={0}
            cursor="pointer"
            userSelect="none"
            onClick={() => {
              // Open billing/upgrade page
              import('@tauri-apps/plugin-opener').then(({ openUrl }) => {
                openUrl('https://toquemedia.com/pricing')
              }).catch(() => {})
            }}
          >
            [{t('terminalMode.upgradeToPro')} ↗]
          </Text>
        </Flex>
      )}

      {/* Attachments as inline mono text tokens — só ficheiros/pastas; imagens
          vivem como token no input. One dense line per attachment: leading
          single-color glyph, name (+ size), and an always-visible bracketed
          [x] remove affordance (the X is plain text, no hover-reveal). */}
      <Box>
        {visibleAttachments.map(att => {
          const glyph = typeGlyphs[att.type]
          const sizeStr = formatSize(att.sizeBytes)

          return (
            <Flex
              key={att.id}
              align="baseline"
              gap={1.5}
              fontFamily={tokens.fontFamily.mono}
              lineHeight="1.6"
              maxW="100%"
            >
              {/* Type glyph */}
              <Text fontSize="11px" color={tokens.colors.text.muted} flexShrink={0} userSelect="none">
                {glyph}
              </Text>

              {/* Name */}
              <Text
                fontSize="11px"
                color={tokens.colors.text.secondary}
                truncate
                minW={0}
              >
                {att.name}
              </Text>

              {/* Size (optional) */}
              {sizeStr && (
                <Text fontSize="11px" color={tokens.colors.text.disabled} flexShrink={0}>
                  {sizeStr}
                </Text>
              )}

              {/* Always-visible bracketed remove affordance */}
              <Text
                as="button"
                fontSize="11px"
                color={tokens.colors.text.disabled}
                flexShrink={0}
                cursor="pointer"
                userSelect="none"
                _hover={{ color: tokens.colors.text.primary }}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation()
                  onRemove(att.id)
                }}
                aria-label={t('terminalMode.removeAttachment')}
              >
                [x]
              </Text>
            </Flex>
          )
        })}
      </Box>
    </Box>
  )
}

export default memo(CmdAttachmentBar)
