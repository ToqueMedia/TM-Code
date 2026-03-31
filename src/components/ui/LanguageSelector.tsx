import { memo } from 'react'
import { t } from '@/i18n'
import { Box, Text, Menu } from '@chakra-ui/react'
import { FiCode } from 'react-icons/fi'
import { useEditorRepository } from '../../stores/editorStore'

const LANGUAGES = [
  'plaintext', 'typescript', 'javascript', 'json', 'html', 'css',
  'scss', 'markdown', 'python', 'rust', 'go', 'java', 'c', 'cpp', 'php', 'sql'
]

interface LanguageSelectorProps {
  activeFile: string | null
  openFiles: Array<{ path: string; language: string; isDirty: boolean }>
}

const LanguageSelector = memo<LanguageSelectorProps>(({ activeFile, openFiles }) => {
  const currentLanguage = (() => {
    const file = openFiles.find(f => f.path === activeFile)
    return file?.language ? file.language : 'Plain Text'
  })()

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
            title={t("explorer.changeLanguage")}
          >
            <FiCode size={12} />
            <Text>{currentLanguage}</Text>
          </Box>
        </Menu.Trigger>
        <Menu.Positioner>
          <Menu.Content>
            {LANGUAGES.map(function (lang) {
              return (
                <Menu.Item value={lang} key={lang} onClick={async function () {
                  if (!activeFile) return
                  try {
                    const monaco = await import('monaco-editor')
                    const model = monaco.editor.getModel(monaco.Uri.file(activeFile))
                    if (model) {
                      monaco.editor.setModelLanguage(model, lang)
                      useEditorRepository.getState().updateEditorState(activeFile, { language: lang })
                    }
                  } catch { }
                }}>{lang}</Menu.Item>
              )
            })}
          </Menu.Content>
        </Menu.Positioner>
      </Menu.Root>
    </Box>
  )
})

LanguageSelector.displayName = 'LanguageSelector'

export default LanguageSelector
