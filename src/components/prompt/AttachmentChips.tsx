import { memo } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiX, FiFile, FiFolder, FiImage } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import type { Attachment } from '../../types/chat'

interface AttachmentChipsProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
}

const typeIcons = {
  file: FiFile,
  folder: FiFolder,
  image: FiImage,
}

function AttachmentChips({ attachments, onRemove }: AttachmentChipsProps) {
  if (attachments.length === 0) return null

  return (
    <Flex px={3} pb={1} pt={0.5} gap={1.5} flexWrap="wrap">
      {attachments.map(att => {
        const Icon = typeIcons[att.type]
        return (
          <Flex
            key={att.id}
            align="center"
            gap={1.5}
            px={2}
            py="3px"
            bg={tokens.colors.bg.card}
            border={`1px solid ${tokens.colors.border.glass}`}
            borderRadius="8px"
            maxW="200px"
            transition="all 0.15s"
            _hover={{ borderColor: tokens.colors.border.subtle }}
          >
            {att.type === 'image' && att.base64 ? (
              <Box
                w="18px"
                h="18px"
                borderRadius="4px"
                overflow="hidden"
                flexShrink={0}
              >
                <img
                  src={att.base64}
                  alt={att.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </Box>
            ) : (
              <Icon size={13} color={tokens.colors.text.muted} style={{ flexShrink: 0 }} />
            )}
            <Text
              fontSize="11.5px"
              color={tokens.colors.text.secondary}
              truncate
              maxW="140px"
            >
              {att.name}
            </Text>
            <Box
              as="button"
              flexShrink={0}
              display="flex"
              alignItems="center"
              justifyContent="center"
              w="16px"
              h="16px"
              borderRadius="4px"
              cursor="pointer"
              color={tokens.colors.text.disabled}
              transition="all 0.1s"
              _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255,255,255,0.06)' }}
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation()
                onRemove(att.id)
              }}
            >
              <FiX size={11} />
            </Box>
          </Flex>
        )
      })}
    </Flex>
  )
}

export default memo(AttachmentChips)
