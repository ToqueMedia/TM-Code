import { memo, useEffect, useRef } from 'react'
import { Box, Flex, Icon, Image, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { getFileIconByExtension, getFolderIconByName, getFolderIconByPath } from '@/utils/iconMapper'
import {
  getDefaultFolderIcon,
  getExtensionIcon,
  getSpecialFileIcon,
  getSpecialFolderIcon,
} from '../ui/filetree/iconMappings'
import type { QuickOpenItem } from '../../services/quickOpenService'

interface MentionMenuProps {
  items: QuickOpenItem[]
  selectedIndex: number
  onSelect: (item: QuickOpenItem) => void
  projectPath: string
}

function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  // Dotfiles (".env", ".gitignore") have no double-extension semantics.
  if (dot <= 0) return ''
  return fileName.slice(dot + 1).toLowerCase()
}

/**
 * Row icon for the @mention picker: per-extension file glyph (Material Icon
 * Theme assets, same resolver the file tree uses) or a folder glyph for
 * directories. Layout-neutral variant of FileTreeIcon (no mr / hover-scale —
 * the menu owns its own spacing).
 */
function MentionRowIcon({ item }: { item: QuickOpenItem }) {
  const materialUrl = item.isDirectory
    ? (getFolderIconByPath(item.path, false) || getFolderIconByName(item.name, false))
    : getFileIconByExtension(getExtension(item.name), item.name)

  if (materialUrl) {
    return (
      <Image
        src={materialUrl}
        alt=""
        boxSize="15px"
        flexShrink={0}
        opacity={0.95}
        pointerEvents="none"
      />
    )
  }

  const { icon, color } = item.isDirectory
    ? getSpecialFolderIcon(item.name.toLowerCase(), false)
      ?? getDefaultFolderIcon(false, false)
    : getSpecialFileIcon(item.name.toLowerCase(), false)
      ?? getExtensionIcon(getExtension(item.name), false)

  return <Icon as={icon} color={color} fontSize="15px" flexShrink={0} />
}

function MentionMenu({ items, selectedIndex, onSelect, projectPath }: MentionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuRef.current) return
    const els = menuRef.current.querySelectorAll('[data-mention-item]')
    const selected = els[selectedIndex]
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (items.length === 0) return null

  return (
    <Box
      ref={menuRef}
      position="absolute"
      bottom="100%"
      left={0}
      right={0}
      mb="6px"
      bg="rgba(15, 15, 15, 0.95)"
      backdropFilter="blur(20px)"
      borderRadius="12px"
      border="1px solid rgba(255, 255, 255, 0.08)"
      boxShadow="0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(254, 16, 99, 0.06)"
      overflow="auto"
      maxH="240px"
      zIndex={tokens.zIndex.dropdown}
      py="4px"
    >
      {items.map((item, index) => {
        const relativePath = item.path.startsWith(projectPath)
          ? item.path.slice(projectPath.length + 1)
          : item.path

        return (
          <Flex
            key={item.path}
            data-mention-item
            px="14px"
            py="8px"
            mx="4px"
            borderRadius="8px"
            cursor="pointer"
            align="center"
            gap={2.5}
            bg={index === selectedIndex ? 'rgba(254, 16, 99, 0.1)' : 'transparent'}
            transition="background 0.1s"
            onClick={() => onSelect(item)}
            _hover={{ bg: index === selectedIndex ? 'rgba(254, 16, 99, 0.1)' : 'rgba(255, 255, 255, 0.04)' }}
          >
            <MentionRowIcon item={item} />
            <Flex direction="column" gap={0} overflow="hidden" flex={1}>
              <Text
                fontSize="13px"
                fontWeight="500"
                color={tokens.colors.text.primary}
                truncate
              >
                {item.name}
                {item.isDirectory ? '/' : ''}
              </Text>
              <Text
                fontSize="11px"
                color={tokens.colors.text.disabled}
                truncate
              >
                {relativePath}
              </Text>
            </Flex>
          </Flex>
        )
      })}
    </Box>
  )
}

export default memo(MentionMenu)
