import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Input, Text, VStack } from '@chakra-ui/react'
import { useProjectStore } from '../../stores/projectStore'
import { useEditorRepository } from '../../stores/editorStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useSettingsStore } from '../../stores/settingsStore'
import MonacoBridge from '../../utils/monacoBridge'
import { tokens } from '../../theme/tokens'

interface CommandItem {
  id: string
  label: string
  category?: string
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
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(function onOpen() {
    function handleOpen() {
      setIsOpen(true)
      setQuery('')
      setIndex(0)
      requestAnimationFrame(() => {
        try { inputRef.current?.focus() } catch {}
      })
    }
    function handleClose() { setIsOpen(false) }
    window.addEventListener('command:palette', handleOpen)
    window.addEventListener('command:palette:close', handleClose)
    return function cleanup() {
      window.removeEventListener('command:palette', handleOpen)
      window.removeEventListener('command:palette:close', handleClose)
    }
  }, [])

  // Focus input when palette opens
  useEffect(() => {
    if (isOpen) requestAnimationFrame(() => inputRef.current?.focus())
  }, [isOpen])

  const close = () => setIsOpen(false)

  /** Close palette, then run an editor action after the DOM updates. */
  function closeAndRunAction(actionId: string) {
    close()
    setTimeout(() => {
      MonacoBridge.getInstance().runAction(actionId)
    }, 100)
  }

  function getCommands(): CommandItem[] {
    const bridge = MonacoBridge.getInstance()
    const hasEditor = !!bridge.getCurrentEditor()
    const hasActiveFile = !!editorRepo.activeFile
    const hasOpenFiles = editorRepo.openFiles.length > 0
    const hasProject = !!currentProject

    const cmds: CommandItem[] = []

    // ── File ────────────────────────────────────────────────────
    cmds.push(
      { id: 'file.quickOpen', label: 'Quick Open', category: 'File', hint: '⌘P', run() { window.dispatchEvent(new CustomEvent('quickopen:toggle')); close() } },
      { id: 'file.openFolder', label: 'Open Folder…', category: 'File', hint: '⌘O', run: async () => {
        try {
          const { open } = await import('@tauri-apps/plugin-dialog')
          const selected = await open({ directory: true, multiple: false, title: 'Select project directory' })
          if (selected) await openProject(String(selected))
        } catch {
        } finally { close() }
      }},
    )
    if (hasEditor) {
      cmds.push(
        { id: 'file.save', label: 'Save', category: 'File', hint: '⌘S', run() { bridge.runAction('tmcode.save'); close() } },
        { id: 'file.saveAll', label: 'Save All', category: 'File', hint: '⌘⌥S', run() {
          // Sync active file content from editor to store before bulk save
          const ed = bridge.getCurrentEditor()
          const { activeFile } = useEditorRepository.getState()
          if (ed && activeFile) {
            const content = ed.getValue()
            useEditorRepository.setState(s => {
              const idx = s.openFiles.findIndex(f => f.path === activeFile)
              if (idx === -1 || s.openFiles[idx].content === content) return s
              const files = [...s.openFiles]
              files[idx] = { ...files[idx], content, isDirty: true }
              return { openFiles: files }
            })
          }
          useEditorRepository.getState().saveAllFiles().catch(() => {})
          close()
        }},
      )
    }
    if (hasActiveFile) {
      cmds.push({ id: 'file.closeTab', label: 'Close Tab', category: 'File', hint: '⌘W', run() {
        const { activeFile, closeFile } = useEditorRepository.getState()
        if (activeFile) closeFile(activeFile)
        close()
      }})
    }
    if (hasOpenFiles) {
      cmds.push({ id: 'file.closeAllTabs', label: 'Close All Tabs', category: 'File', run() {
        useEditorRepository.getState().closeAllFiles()
        close()
      }})
    }

    // ── Edit ────────────────────────────────────────────────────
    if (hasEditor) {
      cmds.push(
        { id: 'edit.undo', label: 'Undo', category: 'Edit', hint: '⌘Z', run() { bridge.trigger('undo'); close() } },
        { id: 'edit.redo', label: 'Redo', category: 'Edit', hint: '⌘⇧Z', run() { bridge.trigger('redo'); close() } },
        { id: 'edit.find', label: 'Find', category: 'Edit', hint: '⌘F', run() { closeAndRunAction('actions.find') } },
        { id: 'edit.replace', label: 'Replace', category: 'Edit', hint: '⌘H', run() { closeAndRunAction('editor.action.startFindReplaceAction') } },
        { id: 'edit.format', label: 'Format Document', category: 'Edit', hint: '⇧⌥F', run() { bridge.runAction('editor.action.formatDocument'); close() } },
        { id: 'edit.toggleComment', label: 'Toggle Line Comment', category: 'Edit', hint: '⌘/', run() { bridge.runAction('editor.action.commentLine'); close() } },
        { id: 'edit.toggleBlockComment', label: 'Toggle Block Comment', category: 'Edit', hint: '⇧⌥A', run() { bridge.runAction('editor.action.blockComment'); close() } },
        { id: 'edit.deleteLine', label: 'Delete Line', category: 'Edit', hint: '⌘⇧K', run() { bridge.runAction('editor.action.deleteLines'); close() } },
        { id: 'edit.moveLineUp', label: 'Move Line Up', category: 'Edit', hint: '⌥↑', run() { bridge.runAction('editor.action.moveLinesUpAction'); close() } },
        { id: 'edit.moveLineDown', label: 'Move Line Down', category: 'Edit', hint: '⌥↓', run() { bridge.runAction('editor.action.moveLinesDownAction'); close() } },
        { id: 'edit.copyLineUp', label: 'Copy Line Up', category: 'Edit', hint: '⇧⌥↑', run() { bridge.runAction('editor.action.copyLinesUpAction'); close() } },
        { id: 'edit.copyLineDown', label: 'Copy Line Down', category: 'Edit', hint: '⇧⌥↓', run() { bridge.runAction('editor.action.copyLinesDownAction'); close() } },
        { id: 'edit.indentLine', label: 'Indent Line', category: 'Edit', hint: '⌘]', run() { bridge.runAction('editor.action.indentLines'); close() } },
        { id: 'edit.outdentLine', label: 'Outdent Line', category: 'Edit', hint: '⌘[', run() { bridge.runAction('editor.action.outdentLines'); close() } },
        { id: 'edit.transformUpper', label: 'Transform to Uppercase', category: 'Edit', run() { bridge.runAction('editor.action.transformToUppercase'); close() } },
        { id: 'edit.transformLower', label: 'Transform to Lowercase', category: 'Edit', run() { bridge.runAction('editor.action.transformToLowercase'); close() } },
      )
    }
    if (hasProject) {
      cmds.push(
        { id: 'edit.findInFiles', label: 'Find in Files', category: 'Edit', hint: '⌘⇧F', run() { window.dispatchEvent(new CustomEvent('search:open')); close() } },
      )
    }

    // ── Selection ───────────────────────────────────────────────
    if (hasEditor) {
      cmds.push(
        { id: 'sel.selectAll', label: 'Select All', category: 'Selection', hint: '⌘A', run() {
          const ed = bridge.getCurrentEditor()
          if (ed) { const m = ed.getModel(); if (m) ed.setSelection(m.getFullModelRange()) }
          close()
        }},
        { id: 'sel.cursorAbove', label: 'Add Cursor Above', category: 'Selection', hint: '⌘⌥↑', run() { bridge.runAction('editor.action.insertCursorAbove'); close() } },
        { id: 'sel.cursorBelow', label: 'Add Cursor Below', category: 'Selection', hint: '⌘⌥↓', run() { bridge.runAction('editor.action.insertCursorBelow'); close() } },
        { id: 'sel.selectAllOccurrences', label: 'Select All Occurrences', category: 'Selection', hint: '⌘⇧L', run() { bridge.runAction('editor.action.selectHighlights'); close() } },
        { id: 'sel.expandSelection', label: 'Expand Selection', category: 'Selection', hint: '⇧⌥→', run() { bridge.runAction('editor.action.smartSelect.expand'); close() } },
        { id: 'sel.shrinkSelection', label: 'Shrink Selection', category: 'Selection', hint: '⇧⌥←', run() { bridge.runAction('editor.action.smartSelect.shrink'); close() } },
      )
    }

    // ── Split Editor ─────────────────────────────────────────────
    if (hasEditor) {
      const isSplit = editorRepo.editorGroups.length >= 2
      cmds.push(
        { id: 'editor.splitEditor', label: isSplit ? 'Unsplit Editor' : 'Split Editor Right', category: 'View', hint: '⌘\\', run() {
          window.dispatchEvent(new CustomEvent('editor:split')); close()
        }},
      )
    }

    // ── View ────────────────────────────────────────────────────
    if (hasEditor) {
      cmds.push(
        { id: 'view.wordWrap', label: 'Toggle Word Wrap', category: 'View', hint: '⌥Z', run() { bridge.runAction('editor.action.toggleWordWrap'); close() } },
        { id: 'view.minimap', label: 'Toggle Minimap', category: 'View', run() { bridge.toggleOption('minimap'); close() } },
        { id: 'view.stickyScroll', label: 'Toggle Sticky Scroll', category: 'View', run() { bridge.toggleOption('stickyScroll'); close() } },
        { id: 'view.zoomIn', label: 'Zoom In', category: 'View', hint: '⌘=', run() { bridge.runAction('editor.action.fontZoomIn'); close() } },
        { id: 'view.zoomOut', label: 'Zoom Out', category: 'View', hint: '⌘-', run() { bridge.runAction('editor.action.fontZoomOut'); close() } },
        { id: 'view.zoomReset', label: 'Reset Zoom', category: 'View', hint: '⌘0', run() { bridge.runAction('editor.action.fontZoomReset'); close() } },
      )
    }
    cmds.push(
      { id: 'view.sidebar', label: 'Toggle Sidebar', category: 'View', hint: '⌘B', run() { window.dispatchEvent(new CustomEvent('sidebar:toggle')); close() } },
      { id: 'view.bottomPanel', label: 'Toggle Bottom Panel', category: 'View', hint: '⌃`', run() { window.dispatchEvent(new CustomEvent('panel:toggle-bottom')); close() } },
    )

    // ── Go ──────────────────────────────────────────────────────
    if (hasEditor) {
      cmds.push(
        { id: 'go.line', label: 'Go to Line…', category: 'Go', hint: '⌘G', run() { close(); setTimeout(() => window.dispatchEvent(new CustomEvent('editor:go-to-line')), 100) } },
        { id: 'go.definition', label: 'Go to Definition', category: 'Go', hint: 'F12', run() { closeAndRunAction('editor.action.revealDefinition') } },
        { id: 'go.peekDefinition', label: 'Peek Definition', category: 'Go', hint: '⌥F12', run() { closeAndRunAction('editor.action.peekDefinition') } },
        { id: 'go.references', label: 'Go to References', category: 'Go', hint: '⇧F12', run() { closeAndRunAction('editor.action.goToReferences') } },
      )
    }

    // ── Fold ────────────────────────────────────────────────────
    if (hasEditor) {
      cmds.push(
        { id: 'fold.fold', label: 'Fold', category: 'Fold', hint: '⌘⇧[', run() { bridge.runAction('editor.fold'); close() } },
        { id: 'fold.unfold', label: 'Unfold', category: 'Fold', hint: '⌘⇧]', run() { bridge.runAction('editor.unfold'); close() } },
        { id: 'fold.foldAll', label: 'Fold All', category: 'Fold', run() { bridge.runAction('editor.foldAll'); close() } },
        { id: 'fold.unfoldAll', label: 'Unfold All', category: 'Fold', run() { bridge.runAction('editor.unfoldAll'); close() } },
        { id: 'fold.foldComments', label: 'Fold All Block Comments', category: 'Fold', run() { bridge.runAction('editor.foldAllBlockComments'); close() } },
        { id: 'fold.level1', label: 'Fold Level 1', category: 'Fold', run() { bridge.runAction('editor.foldLevel1'); close() } },
        { id: 'fold.level2', label: 'Fold Level 2', category: 'Fold', run() { bridge.runAction('editor.foldLevel2'); close() } },
        { id: 'fold.level3', label: 'Fold Level 3', category: 'Fold', run() { bridge.runAction('editor.foldLevel3'); close() } },
      )
    }

    // ── Debug ───────────────────────────────────────────────────
    if (hasProject) {
      cmds.push(
        { id: 'debug.start', label: 'Start Debugging', category: 'Debug', hint: 'F5', run() { window.dispatchEvent(new CustomEvent('debugger:start')); close() } },
        { id: 'debug.stop', label: 'Stop Debugging', category: 'Debug', hint: '⇧F5', run() { window.dispatchEvent(new CustomEvent('debugger:stop')); close() } },
        { id: 'debug.breakpoint', label: 'Toggle Breakpoint', category: 'Debug', hint: 'F9', run() { window.dispatchEvent(new CustomEvent('debugger:toggle-breakpoint')); close() } },
        { id: 'debug.stepOver', label: 'Step Over', category: 'Debug', hint: 'F10', run() { window.dispatchEvent(new CustomEvent('debugger:step-over')); close() } },
        { id: 'debug.stepInto', label: 'Step Into', category: 'Debug', hint: 'F11', run() { window.dispatchEvent(new CustomEvent('debugger:step-into')); close() } },
        { id: 'debug.stepOut', label: 'Step Out', category: 'Debug', hint: '⇧F11', run() { window.dispatchEvent(new CustomEvent('debugger:step-out')); close() } },
      )
    }

    // ── Preferences ─────────────────────────────────────────────
    cmds.push(
      { id: 'pref.settings', label: 'Open Settings', category: 'Preferences', hint: '⌘,', run() { useLayoutStore.getState().setViewMode('settings'); close() } },
      { id: 'pref.formatOnSave', label: 'Toggle Format on Save', category: 'Preferences', hint: useSettingsStore.getState().formatOnSave ? 'ON' : 'OFF', run() {
        const { formatOnSave, setFormatOnSave } = useSettingsStore.getState()
        setFormatOnSave(!formatOnSave)
        close()
      }},
    )

    // ── Navigation ──────────────────────────────────────────────
    cmds.push(
      { id: 'nav.backToChat', label: 'Back to Chat', category: 'Navigation', run() { useLayoutStore.getState().goBack(); close() } },
    )

    return cmds
  }

  const formatOnSave = useSettingsStore(s => s.formatOnSave)
  const allCommands = useMemo(getCommands, [editorRepo.activeFile, editorRepo.openFiles.length, editorRepo.editorGroups.length, currentProject, formatOnSave])

  const filtered = useMemo(function filter() {
    const q = query.trim().toLowerCase()
    if (!q) return allCommands
    const terms = q.split(/\s+/)
    return allCommands.filter(function match(item) {
      const text = ((item.category ? item.category + ' ' : '') + item.label).toLowerCase()
      return terms.every(t => text.includes(t))
    })
  }, [query, allCommands])

  // Keep index in bounds
  useEffect(() => {
    if (index >= filtered.length && filtered.length > 0) setIndex(filtered.length - 1)
  }, [filtered.length, index])

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return
    const activeEl = listRef.current.children[index] as HTMLElement | undefined
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' })
  }, [index])

  // Global keyboard handler — captures keys even if input loses focus in Tauri WebView
  const filteredRef = useRef(filtered)
  const indexRef = useRef(index)
  filteredRef.current = filtered
  indexRef.current = index

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setIsOpen(false); e.preventDefault(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(x => Math.min(x + 1, Math.max(0, filteredRef.current.length - 1))); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(x => Math.max(x - 1, 0)); return }
      if (e.key === 'Enter') {
        e.preventDefault()
        const items = filteredRef.current
        const idx = Math.max(0, Math.min(indexRef.current, items.length - 1))
        const item = items[idx]
        if (item) Promise.resolve(item.run()).catch(() => {})
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [isOpen])

  function onBackdrop(e: React.MouseEvent): void {
    if (e.target === e.currentTarget) setIsOpen(false)
  }

  if (!isOpen) return null

  return (
    <Box position="fixed" inset={0} bg={tokens.colors.bg.blackOverlay} zIndex={2000} onMouseDown={onBackdrop}>
      <Flex justify="center" mt="10vh">
        <Box bg={tokens.colors.bg.app} border={`1px solid ${tokens.colors.border.default}`} borderRadius="12px" width="min(720px, 90vw)" boxShadow={tokens.shadow.overlay}>
          <Box p={3} borderBottom={`1px solid ${tokens.colors.border.subtle}`}>
            <Input
              ref={inputRef}
              type="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={currentProject ? `Command Palette — ${currentProject.name}` : 'Command Palette'}
              value={query}
              onChange={function(e){ setQuery(e.target.value) }}
              bg={tokens.colors.bg.statusbar}
              borderColor={tokens.colors.border.inputAlt}
              color={tokens.colors.text.statusbar}
              _focus={{ borderColor: tokens.colors.accent.primaryBorder, boxShadow: `0 0 0 2px ${tokens.colors.accent.primarySubtle}` }}
            />
          </Box>
          <VStack ref={listRef} align="stretch" maxH="50vh" overflowY="auto" gap={0} py={1}>
            {filtered.length === 0 ? (
              <Box px={3} py={3} color={tokens.colors.text.placeholder}>No results</Box>
            ) : filtered.map(function(item, i){
              const active = i === index
              return (
                <Box
                  key={item.id}
                  px={3}
                  py={2}
                  bg={active ? tokens.colors.bg.activeItem : 'transparent'}
                  _hover={{ bg: tokens.colors.bg.activeItem }}
                  cursor="default"
                  onMouseEnter={function(){ setIndex(i) }}
                  onMouseDown={function(e){ e.preventDefault(); }}
                  onClick={function(){ Promise.resolve(item.run()).catch(function(){}) }}
                >
                  <Flex align="center" justify="space-between" gap={3}>
                    <Text color={tokens.colors.text.statusbar} fontSize="sm" truncate>
                      {item.category && (
                        <Text as="span" color={tokens.colors.text.muted}>{item.category}: </Text>
                      )}
                      {item.label}
                    </Text>
                    {item.hint ? (
                      <Text
                        color={tokens.colors.text.hint}
                        fontSize="11px"
                        bg={tokens.colors.badge.bg}
                        px={1.5}
                        py={0.5}
                        borderRadius="4px"
                        fontFamily={tokens.fontFamily.mono}
                        flexShrink={0}
                        lineHeight="1.3"
                      >
                        {item.hint}
                      </Text>
                    ) : null}
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
