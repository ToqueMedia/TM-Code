import { memo } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiX, FiFile, FiFolder, FiImage, FiAlertTriangle, FiArrowUpRight } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import type { Attachment } from '../../types/chat'

interface CmdAttachmentBarProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
  showImageWarning: boolean
}

const typeIcons = {
  file: FiFile,
  folder: FiFolder,
  image: FiImage,
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
      {/* Billing warning with upgrade CTA */}
      {showImageWarning && (
        <Flex
          align="center"
          gap={2}
          px={2.5}
          py={1.5}
          mb={2}
          bg="rgba(247, 127, 0, 0.06)"
          border="1px solid rgba(247, 127, 0, 0.15)"
          borderRadius="6px"
        >
          <Box color={tokens.colors.accent.orange} flexShrink={0} display="flex" alignItems="center">
            <FiAlertTriangle size={12} />
          </Box>
          <Text
            fontSize="11px"
            color={tokens.colors.accent.orange}
            fontFamily={tokens.fontFamily.mono}
            flex="1"
            lineHeight="1.4"
          >
            {t('terminalMode.imageNotSupported')}
          </Text>
          <Flex
            as="button"
            align="center"
            gap={1}
            px={2}
            py="2px"
            borderRadius="4px"
            bg="rgba(254, 16, 99, 0.1)"
            border="1px solid rgba(254, 16, 99, 0.25)"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{
              bg: 'rgba(254, 16, 99, 0.18)',
              borderColor: 'rgba(254, 16, 99, 0.4)',
            }}
            onClick={() => {
              // Open billing/upgrade page
              import('@tauri-apps/plugin-opener').then(({ openUrl }) => {
                openUrl('https://toquemedia.com/pricing')
              }).catch(() => {})
            }}
            flexShrink={0}
          >
            <Text
              fontSize="10px"
              fontFamily={tokens.fontFamily.mono}
              color={tokens.colors.accent.primary}
              fontWeight="600"
              letterSpacing="0.02em"
            >
              {t('terminalMode.upgradeToPro')}
            </Text>
            <FiArrowUpRight size={10} color={tokens.colors.accent.primary} />
          </Flex>
        </Flex>
      )}

      {/* Attachment chips — só ficheiros/pastas; imagens vivem como token no input */}
      <Flex gap={2} flexWrap="wrap">
        {visibleAttachments.map(att => {
          const Icon = typeIcons[att.type]
          const sizeStr = formatSize(att.sizeBytes)

          return (
            <Flex
              key={att.id}
              align="center"
              gap={2}
              pl={2}
              pr={1.5}
              py="3px"
              bg="rgba(255, 255, 255, 0.04)"
              border="1px solid rgba(255, 255, 255, 0.06)"
              borderRadius="6px"
              maxW="240px"
              overflow="hidden"
              transition="all 0.15s"
              _hover={{
                bg: 'rgba(255, 255, 255, 0.06)',
                borderColor: 'rgba(255, 255, 255, 0.1)',
              }}
              position="relative"
              role="group"
            >
              {/* Icon */}
              <Box flexShrink={0} display="flex" alignItems="center">
                <Icon size={13} color={tokens.colors.text.muted} />
              </Box>

              {/* Label: images use the [Image #N] chip text, others name + size */}
              <Flex direction="column" minW={0} flex="1">
                <Text
                  fontSize="11px"
                  fontFamily={tokens.fontFamily.mono}
                  color={tokens.colors.text.secondary}
                  truncate
                  lineHeight="1.3"
                >
                  {att.name}
                </Text>
                {sizeStr && (
                  <Text
                    fontSize="9px"
                    fontFamily={tokens.fontFamily.mono}
                    color={tokens.colors.text.disabled}
                    lineHeight="1.3"
                  >
                    {sizeStr}
                  </Text>
                )}
              </Flex>

              {/* Remove button */}
              <Box
                as="button"
                flexShrink={0}
                display="flex"
                alignItems="center"
                justifyContent="center"
                w="18px"
                h="18px"
                borderRadius="4px"
                cursor="pointer"
                color={tokens.colors.text.disabled}
                transition="all 0.1s"
                opacity={0}
                _groupHover={{ opacity: 1 }}
                _hover={{
                  color: tokens.colors.text.primary,
                  bg: 'rgba(255, 255, 255, 0.08)',
                }}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation()
                  onRemove(att.id)
                }}
                aria-label={t('terminalMode.removeAttachment')}
              >
                <FiX size={11} />
              </Box>
            </Flex>
          )
        })}
      </Flex>
    </Box>
  )
}

export default memo(CmdAttachmentBar)
