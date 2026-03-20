import { memo } from 'react'
import { Box, Text, Menu } from '@chakra-ui/react'
import { FiChevronDown, FiCheck } from 'react-icons/fi'
import { useEditorRepository } from '../../stores/editorStore'
import { tokens } from '@/theme/tokens'

interface IndentationMenuProps {
  tabSizeSetting: number
  insertSpacesSetting: boolean
  detectIndentationSetting: boolean
  setTabSizeSetting: (size: number) => void
  setInsertSpacesSetting: (value: boolean) => void
  setDetectIndentationSetting: (value: boolean) => void
}

function convertIndentation(tabSize: number, toSpaces: boolean): void {
  const state = useEditorRepository.getState()
  const path = state.activeFile
  if (!path) return
  const file = state.openFiles.find(f => f.path === path)
  if (!file || !file.content) return

  const spaces = ' '.repeat(tabSize)
  const lines = file.content.split('\n')
  const converted = lines.map(line => {
    const match = line.match(/^(\s*)/)
    if (!match || !match[1]) return line
    const indent = match[1]
    const rest = line.slice(indent.length)
    const newIndent = toSpaces
      ? indent.replace(/\t/g, spaces)
      : indent.replace(new RegExp(spaces, 'g'), '\t')
    return newIndent + rest
  }).join('\n')

  if (converted !== file.content) {
    state.updateFileContent(path, converted)
  }
}

const menuItemStyle = {
  fontSize: '12px',
  py: '6px',
  px: 3,
  cursor: 'pointer',
  color: tokens.colors.text.secondary,
  _hover: { bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary },
  transition: `all ${tokens.transition.fast}`,
  borderRadius: '4px',
}

const IndentationMenu = memo<IndentationMenuProps>(({
  tabSizeSetting,
  insertSpacesSetting,
  detectIndentationSetting,
  setTabSizeSetting,
  setInsertSpacesSetting,
  setDetectIndentationSetting
}) => {
  return (
    <Box position="relative">
      <Menu.Root>
        <Menu.Trigger asChild>
          <Box as="button"
            px={2}
            py={0.5}
            fontSize="11px"
            display="flex"
            alignItems="center"
            gap={1}
            _hover={{ bg: tokens.colors.bg.hoverSubtle }}
            borderRadius="3px"
            cursor="pointer"
            color={tokens.colors.text.secondary}
            transition={`all ${tokens.transition.fast}`}
          >
            <Text fontFamily={tokens.fontFamily.mono} fontWeight="400">
              {insertSpacesSetting ? 'Spaces' : 'Tabs'}: {tabSizeSetting}
            </Text>
            <FiChevronDown size={10} />
          </Box>
        </Menu.Trigger>
        <Menu.Positioner>
          <Menu.Content
            bg={tokens.colors.bg.overlay}
            border={`1px solid ${tokens.colors.border.subtle}`}
            borderRadius="8px"
            py={1}
            px={1}
            boxShadow="0 8px 32px rgba(0,0,0,0.5)"
            minW="220px"
          >
            {/* Indent mode */}
            <Menu.Item value="indent-spaces" {...menuItemStyle} onClick={() => {
              setDetectIndentationSetting(false)
              setInsertSpacesSetting(true)
            }}>
              <Box display="flex" alignItems="center" gap={2} flex="1">
                <Box w="14px">{insertSpacesSetting && !detectIndentationSetting && <FiCheck size={12} color={tokens.colors.accent.primary} />}</Box>
                Indent Using Spaces
              </Box>
            </Menu.Item>
            <Menu.Item value="indent-tabs" {...menuItemStyle} onClick={() => {
              setDetectIndentationSetting(false)
              setInsertSpacesSetting(false)
            }}>
              <Box display="flex" alignItems="center" gap={2} flex="1">
                <Box w="14px">{!insertSpacesSetting && !detectIndentationSetting && <FiCheck size={12} color={tokens.colors.accent.primary} />}</Box>
                Indent Using Tabs
              </Box>
            </Menu.Item>

            <Box h="1px" bg={tokens.colors.border.subtle} my={1} mx={2} />

            {/* Tab sizes */}
            {[2, 4, 8].map(size => (
              <Menu.Item key={size} value={`tab-${size}`} {...menuItemStyle} onClick={() => {
                setDetectIndentationSetting(false)
                setTabSizeSetting(size)
              }}>
                <Box display="flex" alignItems="center" gap={2} flex="1">
                  <Box w="14px">{tabSizeSetting === size && <FiCheck size={12} color={tokens.colors.accent.primary} />}</Box>
                  Tab Size: {size}
                </Box>
              </Menu.Item>
            ))}

            <Box h="1px" bg={tokens.colors.border.subtle} my={1} mx={2} />

            {/* Detect */}
            <Menu.Item value="detect-toggle" {...menuItemStyle} onClick={() => {
              setDetectIndentationSetting(!detectIndentationSetting)
            }}>
              <Box display="flex" alignItems="center" gap={2} flex="1">
                <Box w="14px">{detectIndentationSetting && <FiCheck size={12} color={tokens.colors.accent.primary} />}</Box>
                Detect Indentation
              </Box>
            </Menu.Item>

            <Box h="1px" bg={tokens.colors.border.subtle} my={1} mx={2} />

            {/* Convert */}
            <Menu.Item value="convert-spaces" {...menuItemStyle} onClick={() => {
              convertIndentation(tabSizeSetting, true)
              setDetectIndentationSetting(false)
              setInsertSpacesSetting(true)
            }}>
              <Box display="flex" alignItems="center" gap={2} flex="1">
                <Box w="14px" />
                Convert Indentation to Spaces
              </Box>
            </Menu.Item>
            <Menu.Item value="convert-tabs" {...menuItemStyle} onClick={() => {
              convertIndentation(tabSizeSetting, false)
              setDetectIndentationSetting(false)
              setInsertSpacesSetting(false)
            }}>
              <Box display="flex" alignItems="center" gap={2} flex="1">
                <Box w="14px" />
                Convert Indentation to Tabs
              </Box>
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Menu.Root>
    </Box>
  )
})

IndentationMenu.displayName = 'IndentationMenu'

export default IndentationMenu
