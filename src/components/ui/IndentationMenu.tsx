import { memo } from 'react'
import { Box, Text, Menu } from '@chakra-ui/react'
import { FiChevronDown } from 'react-icons/fi'
import MonacoBridge from '../../utils/monacoBridge'
import { tokens } from '@/theme/tokens'

interface IndentationMenuProps {
  tabSizeSetting: number
  insertSpacesSetting: boolean
  detectIndentationSetting: boolean
  setTabSizeSetting: (size: number) => void
  setInsertSpacesSetting: (value: boolean) => void
  setDetectIndentationSetting: (value: boolean) => void
}

function applyIndentationNow(tabSize: number, insertSpaces: boolean, detect: boolean): void {
  try {
    const editor = MonacoBridge.getInstance().getCurrentEditor()
    if (!editor) return
    editor.updateOptions({ tabSize, insertSpaces })
    const model = editor.getModel?.()
    if (model) {
      if (detect) {
        ;(model as unknown as { detectIndentation(insertSpaces: boolean, tabSize: number): void })
          .detectIndentation(insertSpaces, tabSize)
      } else {
        model.updateOptions({ tabSize, indentSize: tabSize, insertSpaces })
      }
    }
  } catch { }
}

function convertToSpaces(tabSize: number): void {
  try {
    const editor = MonacoBridge.getInstance().getCurrentEditor()
    if (!editor) return
    const model = editor.getModel?.()
    if (!model) return
    const edits: Array<{ range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }> = []
    const lineCount = model.getLineCount()
    for (let i = 1; i <= lineCount; i++) {
      const content = model.getLineContent(i)
      let firstCol = model.getLineFirstNonWhitespaceColumn(i)
      if (firstCol === 0) firstCol = content.length + 1
      const indent = content.slice(0, Math.max(0, firstCol - 1))
      const desired = indent.replace(/\t/g, ' '.repeat(tabSize))
      if (indent !== desired) {
        edits.push({
          range: { startLineNumber: i, startColumn: 1, endLineNumber: i, endColumn: firstCol },
          text: desired,
        })
      }
    }
    if (edits.length > 0) {
      editor.pushUndoStop()
      editor.executeEdits('indent-convert-spaces', edits)
      editor.pushUndoStop()
    }
  } catch { }
}

function convertToTabs(tabSize: number): void {
  try {
    const editor = MonacoBridge.getInstance().getCurrentEditor()
    if (!editor) return
    const model = editor.getModel?.()
    if (!model) return
    const edits: Array<{ range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }> = []
    const lineCount = model.getLineCount()
    const spaces = ' '.repeat(tabSize)
    for (let i = 1; i <= lineCount; i++) {
      const content = model.getLineContent(i)
      let firstCol = model.getLineFirstNonWhitespaceColumn(i)
      if (firstCol === 0) firstCol = content.length + 1
      const indent = content.slice(0, Math.max(0, firstCol - 1))
      let desired = indent
      if (spaces.length > 0) {
        const re = new RegExp(spaces, 'g')
        desired = indent.replace(re, '\t')
      }
      if (indent !== desired) {
        edits.push({
          range: { startLineNumber: i, startColumn: 1, endLineNumber: i, endColumn: firstCol },
          text: desired,
        })
      }
    }
    if (edits.length > 0) {
      editor.pushUndoStop()
      editor.executeEdits('indent-convert-tabs', edits)
      editor.pushUndoStop()
    }
  } catch { }
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
            px={3}
            py={1}
            fontSize="xs"
            display="flex"
            alignItems="center"
            gap={1}
            _hover={{ bg: 'whiteAlpha.100' }}
            borderRadius="4px"
            title="Change indentation"
            cursor="pointer"
          >
            <Text>{insertSpacesSetting ? 'Spaces' : 'Tabs'}: {tabSizeSetting}</Text>
            <FiChevronDown size={12} />
          </Box>
        </Menu.Trigger>
        <Menu.Positioner>
          <Menu.Content bg={tokens.colors.bg.app} border={`1px solid ${tokens.colors.border.subtle}`}>
            <Menu.Item value="indent-spaces" onClick={function () {
              setDetectIndentationSetting(false)
              setInsertSpacesSetting(true)
              applyIndentationNow(tabSizeSetting, true, false)
            }}>Indent Using Spaces</Menu.Item>
            <Menu.Item value="indent-tabs" onClick={function () {
              setDetectIndentationSetting(false)
              setInsertSpacesSetting(false)
              applyIndentationNow(tabSizeSetting, false, false)
            }}>Indent Using Tabs</Menu.Item>
            <Menu.Separator />
            <Menu.Item value="tab-2" onClick={function () {
              setDetectIndentationSetting(false)
              setTabSizeSetting(2)
              applyIndentationNow(2, insertSpacesSetting, false)
            }}>Tab Size: 2</Menu.Item>
            <Menu.Item value="tab-4" onClick={function () {
              setDetectIndentationSetting(false)
              setTabSizeSetting(4)
              applyIndentationNow(4, insertSpacesSetting, false)
            }}>Tab Size: 4</Menu.Item>
            <Menu.Item value="tab-8" onClick={function () {
              setDetectIndentationSetting(false)
              setTabSizeSetting(8)
              applyIndentationNow(8, insertSpacesSetting, false)
            }}>Tab Size: 8</Menu.Item>
            <Menu.Separator />
            <Menu.Item value="detect-toggle" onClick={function () {
              const next = !detectIndentationSetting
              setDetectIndentationSetting(next)
              applyIndentationNow(tabSizeSetting, insertSpacesSetting, next)
            }}>
              {detectIndentationSetting ? '✓ Detect Indentation' : 'Detect Indentation (Off)'}
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item value="convert-spaces" onClick={function () {
              convertToSpaces(tabSizeSetting)
              setDetectIndentationSetting(false)
              setInsertSpacesSetting(true)
              applyIndentationNow(tabSizeSetting, true, false)
            }}>Convert Indentation to Spaces</Menu.Item>
            <Menu.Item value="convert-tabs" onClick={function () {
              convertToTabs(tabSizeSetting)
              setDetectIndentationSetting(false)
              setInsertSpacesSetting(false)
              applyIndentationNow(tabSizeSetting, false, false)
            }}>Convert Indentation to Tabs</Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Menu.Root>
    </Box>
  )
})

IndentationMenu.displayName = 'IndentationMenu'

export default IndentationMenu
