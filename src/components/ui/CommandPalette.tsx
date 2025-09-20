import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Input, Text, VStack } from '@chakra-ui/react'
import { useProjectStore } from '../../stores/projectStore'
import { useEditorRepository } from '../../stores/editorStore'

interface CommandItem {
  id: string
  title: string
  hint?: string
  run: () => void | Promise<void>
}

function CommandPalette(): React.ReactElement | null {
  const { currentProject, openProject } = useProjectStore()
  const editorRepo = useEditorRepository()

  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(function onOpen() {
    function handleOpen() {
      setIsOpen(true)
      setQuery('')
      setIndex(0)
      setTimeout(function focusLater() {
        try { inputRef.current?.focus() } catch {}
      }, 0)
    }
    function handleClose() { setIsOpen(false) }
    window.addEventListener('command:palette', handleOpen)
    window.addEventListener('command:palette:close', handleClose)
    return function cleanup() {
      window.removeEventListener('command:palette', handleOpen)
      window.removeEventListener('command:palette:close', handleClose)
    }
  }, [])

  function runQuickOpen(): void {
    window.dispatchEvent(new CustomEvent('quickopen:toggle'))
    setIsOpen(false)
  }

  async function runOpenFolder(): Promise<void> {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false, title: 'Select project directory' })
      if (selected) { await openProject(String(selected)) }
      setIsOpen(false)
    } catch {}
  }

  function runToggleBottom(): void {
    window.dispatchEvent(new CustomEvent('panel:toggle-bottom'))
    setIsOpen(false)
  }

  function runPreferences(): void {
    window.dispatchEvent(new CustomEvent('app:preferences'))
    setIsOpen(false)
  }

  function runCloseTab(): void {
    try {
      const { activeFile, closeFile } = useEditorRepository.getState()
      if (activeFile) closeFile(activeFile)
    } catch {}
    setIsOpen(false)
  }

  function getCommands(): CommandItem[] {
    const cmds: CommandItem[] = [
      { id: 'quick-open', title: 'Quick Open', hint: 'Cmd+P', run: runQuickOpen },
      { id: 'open-folder', title: 'Open Folder…', hint: 'Cmd+O', run: runOpenFolder },
      { id: 'toggle-bottom', title: 'Toggle Bottom Panel', hint: 'Ctrl+`', run: runToggleBottom },
      { id: 'preferences', title: 'Preferences', hint: 'Cmd+,', run: runPreferences },
    ]
    if (editorRepo.activeFile) {
      cmds.unshift({ id: 'close-tab', title: 'Close Tab', hint: 'Cmd+W', run: runCloseTab })
    }
    return cmds
  }

  const allCommands = getCommands()
  const filtered = useMemo(function filter() {
    const q = query.trim().toLowerCase()
    if (!q) return allCommands
    return allCommands.filter(function c(item) {
      return item.title.toLowerCase().includes(q)
    })
  }, [query, editorRepo.activeFile])

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') { setIsOpen(false); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(function i(x){ return Math.min(x + 1, Math.max(0, filtered.length - 1)) }) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(function i(x){ return Math.max(x - 1, 0) }) }
    if (e.key === 'Enter') {
      const item = filtered[Math.max(0, Math.min(index, Math.max(0, filtered.length - 1)))]
      if (item) { Promise.resolve(item.run()).catch(function(){}) }
    }
  }

  function onBackdrop(e: React.MouseEvent): void {
    if (e.target === e.currentTarget) setIsOpen(false)
  }

  if (!isOpen) return null

  return (
    <Box position="fixed" inset={0} bg="rgba(0,0,0,0.5)" zIndex={2000} onMouseDown={onBackdrop}>
      <Flex justify="center" mt="10vh">
        <Box bg="#1e1e1e" border="1px solid #3c3c3c" borderRadius="12px" width="min(720px, 90vw)" boxShadow="0 12px 40px rgba(0,0,0,0.5)">
          <Box p={3} borderBottom="1px solid #2b2b2c">
            <Input
              ref={inputRef}
              type="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={currentProject ? `Command Palette — ${currentProject.name}` : 'Command Palette'}
              value={query}
              onChange={function(e){ setQuery(e.target.value) }}
              onKeyDown={onKeyDown}
              bg="#0f172a"
              borderColor="#334155"
              color="#e2e8f0"
              _focus={{ borderColor: '#60a5fa', boxShadow: '0 0 0 2px rgba(96,165,250,0.35)' }}
            />
          </Box>
          <VStack align="stretch" maxH="50vh" overflowY="auto">
            {filtered.length === 0 ? (
              <Box px={3} py={3} color="#94a3b8">No results</Box>
            ) : filtered.map(function(item, i){
              const active = i === index
              return (
                <Box
                  key={item.id}
                  px={3}
                  py={2}
                  bg={active ? '#0b2a4a' : 'transparent'}
                  _hover={{ bg: '#0b2a4a' }}
                  cursor="default"
                  onMouseEnter={function(){ setIndex(i) }}
                  onMouseDown={function(e){ e.preventDefault(); }}
                  onClick={function(){ Promise.resolve(item.run()).catch(function(){}) }}
                >
                  <Flex align="center" justify="space-between">
                    <Text color="#e2e8f0" fontSize="sm">{item.title}</Text>
                    {item.hint ? <Text color="#64748b" fontSize="xs">{item.hint}</Text> : null}
                  </Flex>
                </Box>
              )
            })}
          </VStack>
        </Box>
      </Flex>
    </Box>
  )
}

export default CommandPalette
