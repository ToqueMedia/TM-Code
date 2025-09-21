import React, { useEffect, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  Field,
  HStack,
  Portal,
  NativeSelect,
  Switch,
  Text,
} from '@chakra-ui/react'
import { useSettingsStore } from '../../stores/settingsStore'

interface PreferencesDialogProps {}

export default function PreferencesDialog(_: PreferencesDialogProps): React.ReactElement | null {
  const tabSize = useSettingsStore(function (s) { return s.editor.tabSize })
  const insertSpaces = useSettingsStore(function (s) { return s.editor.insertSpaces })
  const detectIndentation = useSettingsStore(function (s) { return s.editor.detectIndentation })

  const setTabSize = useSettingsStore(function (s) { return s.setTabSize })
  const setInsertSpaces = useSettingsStore(function (s) { return s.setInsertSpaces })
  const setDetectIndentation = useSettingsStore(function (s) { return s.setDetectIndentation })

  const [isOpen, setIsOpen] = useState(false)

  useEffect(function onEvent() {
    function openPreferences() { setIsOpen(true) }
    function closePreferences() { setIsOpen(false) }
    window.addEventListener('app:preferences', openPreferences)
    window.addEventListener('app:preferences:close', closePreferences)
    return function cleanup() {
      window.removeEventListener('app:preferences', openPreferences)
      window.removeEventListener('app:preferences:close', closePreferences)
    }
  }, [])

  function onClose(): void { setIsOpen(false) }

  return (
    <Dialog.Root open={isOpen} onOpenChange={function (e) { if (!e.open) onClose() }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            bg="#1e1e1e"
            color="#e6e6e6"
            border="1px solid"
            borderColor="#3c3c3c"
            minW="560px"
          >
            <Dialog.Header
              bg="#2a2a2a"
              borderBottom="1px solid"
              borderColor="#3c3c3c"
              color="#ffffff"
            >
              <Dialog.Title>Preferences</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body bg="#1e1e1e" pb={6}>
              <Text
                fontSize="sm"
                color="#cccccc"
                mb={3}
                fontWeight="600"
              >
                Editor — Indentation
              </Text>

              <Field.Root mb={4}>
                <Field.Label
                  color="#e6e6e6"
                  fontWeight="600"
                  fontSize="14px"
                >
                  Tab Size
                </Field.Label>
                <Box mt={1}>
                  <NativeSelect.Root
                    size="sm"
                    width="200px"
                  >
                    <NativeSelect.Field 
                      bg="#2a2a2a" 
                      borderColor="#3c3c3c" 
                      color="#e6e6e6"
                      value={String(tabSize)}
                      onChange={function(e){ const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) setTabSize(v) }}
                    >
                      <option value="2">2</option>
                      <option value="4">4</option>
                      <option value="8">8</option>
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                </Box>
              </Field.Root>

              <Field.Root mb={4}>
                <Field.Label
                  color="#e6e6e6"
                  fontWeight="600"
                  fontSize="14px"
                >
                  Insert Spaces
                </Field.Label>
                <HStack
                  justify="space-between"
                  mt={1}
                >
                  <Text
                    color="#a3a3a3"
                    fontSize="sm"
                  >
                    Use spaces instead of tabs
                  </Text>
                  <Switch.Root
                    checked={insertSpaces}
                    onCheckedChange={function(e) { setInsertSpaces(e.checked) }}
                    colorPalette="blue"
                  >
                    <Switch.HiddenInput />
                    <Switch.Control />
                  </Switch.Root>
                </HStack>
              </Field.Root>

              <Field.Root mb={2}>
                <Field.Label
                  color="#e6e6e6"
                  fontWeight="600"
                  fontSize="14px"
                >
                  Detect Indentation
                </Field.Label>
                <HStack
                  justify="space-between"
                  mt={1}
                >
                  <Text
                    color="#a3a3a3"
                    fontSize="sm"
                  >
                    Infer indentation from file content
                  </Text>
                  <Switch.Root
                    checked={detectIndentation}
                    onCheckedChange={function(e) { setDetectIndentation(e.checked) }}
                    colorPalette="blue"
                  >
                    <Switch.HiddenInput />
                    <Switch.Control />
                  </Switch.Root>
                </HStack>
              </Field.Root>
            </Dialog.Body>

            <Dialog.Footer
              bg="#2a2a2a"
              borderTop="1px solid"
              borderColor="#3c3c3c"
            >
              <Button
                variant="outline"
                onClick={onClose}
                color="#e6e6e6"
                borderColor="#3c3c3c"
                _hover={{
                  bg: 'rgba(255,255,255,0.06)',
                  borderColor: '#5b5b5b'
                }}
              >
                Close
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}