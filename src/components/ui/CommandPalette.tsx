import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Input, Text, VStack } from '@chakra-ui/react'
import { useProjectStore } from '../../stores/projectStore'
import { useEditorRepository } from '../../stores/editorStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useSettingsStore } from '../../stores/settingsStore'
import MonacoBridge from '../../utils/monacoBridge'
import { tokens } from '../../theme/tokens'
import { t } from '@/i18n'

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
      { id: 'file.quickOpen', label: t('menu.quickOpen'), category: t('menu.file'), hint: '⌘P', run() { window.dispatchEvent(new CustomEvent('quickopen:toggle')); close() } },
      { id: 'file.openFolder', label: t('menu.openFolder'), category: t('menu.file'), hint: '⌘O', run: async () => {
        try {
          const { open } = await import('@tauri-apps/plugin-dialog')
          const selected = await open({ directory: true, multiple: false, title: t('common.selectProjectDir') })
          if (selected) await openProject(String(selected))
        } catch {
        } finally { close() }
      }},
    )
    if (hasEditor) {
      cmds.push(
        { id: 'file.save', label: t('menu.save'), category: t('menu.file'), hint: '⌘S', run() { bridge.runAction('tmcode.save'); close() } },
        { id: 'file.saveAll', label: t('menu.saveAll'), category: t('menu.file'), hint: '⌘⌥S', run() {
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
      cmds.push({ id: 'file.closeTab', label: t('menu.closeTab'), category: t('menu.file'), hint: '⌘W', run() {
        const { activeFile, closeFile } = useEditorRepository.getState()
        if (activeFile) closeFile(activeFile)
        close()
      }})
    }
    if (hasOpenFiles) {
      cmds.push({ id: 'file.closeAllTabs', label: t('menu.closeAllTabs'), category: t('menu.file'), run() {
        useEditorRepository.getState().closeAllFiles()
        close()
      }})
    }

    // ── Edit ────────────────────────────────────────────────────
    if (hasEditor) {
      cmds.push(
        { id: 'edit.undo', label: t('menu.undo'), category: t('menu.edit'), hint: '⌘Z', run() { bridge.trigger('undo'); close() } },
        { id: 'edit.redo', label: t('menu.redo'), category: t('menu.edit'), hint: '⌘⇧Z', run() { bridge.trigger('redo'); close() } },
        { id: 'edit.find', label: t('menu.find'), category: t('menu.edit'), hint: '⌘F', run() { closeAndRunAction('actions.find') } },
        { id: 'edit.replace', label: t('menu.replace'), category: t('menu.edit'), hint: '⌘H', run() { closeAndRunAction('editor.action.startFindReplaceAction') } },
        { id: 'edit.format', label: t('menu.formatDocument'), category: t('menu.edit'), hint: '⇧⌥F', run() { bridge.runAction('editor.action.formatDocument'); close() } },
        { id: 'edit.toggleComment', label: t('menu.toggleLineComment'), category: t('menu.edit'), hint: '⌘/', run() { bridge.runAction('editor.action.commentLine'); close() } },
        { id: 'edit.toggleBlockComment', label: t('menu.toggleBlockComment'), category: t('menu.edit'), hint: '⇧⌥A', run() { bridge.runAction('editor.action.blockComment'); close() } },
        { id: 'edit.deleteLine', label: t('menu.undo'), category: t('menu.edit'), hint: '⌘⇧K', run() { bridge.runAction('editor.action.deleteLines'); close() } },
        { id: 'edit.moveLineUp', label: t('cmd.moveLineUp'), category: t('menu.edit'), hint: '⌥↑', run() { bridge.runAction('editor.action.moveLinesUpAction'); close() } },
        { id: 'edit.moveLineDown', label: t('cmd.moveLineDown'), category: t('menu.edit'), hint: '⌥↓', run() { bridge.runAction('editor.action.moveLinesDownAction'); close() } },
        { id: 'edit.copyLineUp', label: t('cmd.copyLineUp'), category: t('menu.edit'), hint: '⇧⌥↑', run() { bridge.runAction('editor.action.copyLinesUpAction'); close() } },
        { id: 'edit.copyLineDown', label: t('cmd.copyLineDown'), category: t('menu.edit'), hint: '⇧⌥↓', run() { bridge.runAction('editor.action.copyLinesDownAction'); close() } },
        { id: 'edit.indentLine', label: t('cmd.indentLine'), category: t('menu.edit'), hint: '⌘]', run() { bridge.runAction('editor.action.indentLines'); close() } },
        { id: 'edit.outdentLine', label: t('cmd.outdentLine'), category: t('menu.edit'), hint: '⌘[', run() { bridge.runAction('editor.action.outdentLines'); close() } },
        { id: 'edit.transformUpper', label: t('cmd.transformUpper'), category: t('menu.edit'), run() { bridge.runAction('editor.action.transformToUppercase'); close() } },
        { id: 'edit.transformLower', label: t('cmd.transformLower'), category: t('menu.edit'), run() { bridge.runAction('editor.action.transformToLowercase'); close() } },
      )
    }
    if (hasProject) {
      cmds.push(
        { id: 'edit.findInFiles', label: t('menu.findInFiles'), category: t('menu.edit'), hint: '⌘⇧F', run() { window.dispatchEvent(new CustomEvent('search:open')); close() } },
      )
    }

    // ── Selection ───────────────────────────────────────────────
    if (hasEditor) {
      cmds.push(
        { id: 'sel.selectAll', label: t('cmd.selectAll'), category: t('cmd.category.selection'), hint: '⌘A', run() {
          const ed = bridge.getCurrentEditor()
          if (ed) { const m = ed.getModel(); if (m) ed.setSelection(m.getFullModelRange()) }
          close()
        }},
        { id: 'sel.cursorAbove', label: t('cmd.selectAll'), category: t('cmd.category.selection'), hint: '⌘⌥↑', run() { bridge.runAction('editor.action.insertCursorAbove'); close() } },
        { id: 'sel.cursorBelow', label: t('cmd.selectAll'), category: t('cmd.category.selection'), hint: '⌘⌥↓', run() { bridge.runAction('editor.action.insertCursorBelow'); close() } },
        { id: 'sel.selectAllOccurrences', label: t('ctx.selectAllOccurrences'), category: t('cmd.category.selection'), hint: '⌘⇧L', run() { bridge.runAction('editor.action.selectHighlights'); close() } },
        { id: 'sel.expandSelection', label: t('cmd.expandSelection'), category: t('cmd.category.selection'), hint: '⇧⌥→', run() { bridge.runAction('editor.action.smartSelect.expand'); close() } },
        { id: 'sel.shrinkSelection', label: t('cmd.shrinkSelection'), category: t('cmd.category.selection'), hint: '⇧⌥←', run() { bridge.runAction('editor.action.smartSelect.shrink'); close() } },
      )
    }

    // ── Split Editor ─────────────────────────────────────────────
    if (hasEditor) {
      const isSplit = editorRepo.editorGroups.length >= 2
      cmds.push(
        { id: 'editor.splitEditor', label: isSplit ? t('cmd.unsplitEditor') : t('cmd.splitEditorRight'), category: t('menu.view'), hint: '⌘\\', run() {
          window.dispatchEvent(new CustomEvent('editor:split')); close()
        }},
      )
    }

    // ── View ────────────────────────────────────────────────────
    if (hasEditor) {
      cmds.push(
        { id: 'view.wordWrap', label: t('menu.toggleWordWrap'), category: t('menu.view'), hint: '⌥Z', run() { bridge.runAction('editor.action.toggleWordWrap'); close() } },
        { id: 'view.minimap', label: t('menu.toggleMinimap'), category: t('menu.view'), run() { bridge.toggleOption('minimap'); close() } },
        { id: 'view.stickyScroll', label: t('menu.toggleStickyScroll'), category: t('menu.view'), run() { bridge.toggleOption('stickyScroll'); close() } },
        { id: 'view.zoomIn', label: t('menu.zoomIn'), category: t('menu.view'), hint: '⌘=', run() { bridge.runAction('editor.action.fontZoomIn'); close() } },
        { id: 'view.zoomOut', label: t('menu.zoomOut'), category: t('menu.view'), hint: '⌘-', run() { bridge.runAction('editor.action.fontZoomOut'); close() } },
        { id: 'view.zoomReset', label: t('menu.resetZoom'), category: t('menu.view'), hint: '⌘0', run() { bridge.runAction('editor.action.fontZoomReset'); close() } },
      )
    }
    cmds.push(
      { id: 'view.sidebar', label: t('menu.toggleSidebar'), category: t('menu.view'), hint: '⌘B', run() { window.dispatchEvent(new CustomEvent('sidebar:toggle')); close() } },
      { id: 'view.bottomPanel', label: t('menu.toggleBottomPanel'), category: t('menu.view'), hint: '⌃`', run() { window.dispatchEvent(new CustomEvent('panel:toggle-bottom')); close() } },
    )

    // ── Go ──────────────────────────────────────────────────────
    if (hasEditor) {
      cmds.push(
        { id: 'go.line', label: t('menu.goToLine'), category: t('menu.go'), hint: '⌘G', run() { close(); setTimeout(() => window.dispatchEvent(new CustomEvent('editor:go-to-line')), 100) } },
        { id: 'go.definition', label: t('menu.goToDefinition'), category: t('menu.go'), hint: 'F12', run() { closeAndRunAction('editor.action.revealDefinition') } },
        { id: 'go.peekDefinition', label: t('menu.peekDefinition'), category: t('menu.go'), hint: '⌥F12', run() { closeAndRunAction('editor.action.peekDefinition') } },
        { id: 'go.references', label: t('menu.goToReferences'), category: t('menu.go'), hint: '⇧F12', run() { closeAndRunAction('editor.action.goToReferences') } },
      )
    }

    // ── Fold ────────────────────────────────────────────────────
    if (hasEditor) {
      cmds.push(
        { id: 'fold.fold', label: t('cmd.fold'), category: t('cmd.category.fold'), hint: '⌘⇧[', run() { bridge.runAction('editor.fold'); close() } },
        { id: 'fold.unfold', label: t('cmd.unfold'), category: t('cmd.category.fold'), hint: '⌘⇧]', run() { bridge.runAction('editor.unfold'); close() } },
        { id: 'fold.foldAll', label: t('cmd.foldAll'), category: t('cmd.category.fold'), run() { bridge.runAction('editor.foldAll'); close() } },
        { id: 'fold.unfoldAll', label: t('cmd.unfoldAll'), category: t('cmd.category.fold'), run() { bridge.runAction('editor.unfoldAll'); close() } },
        { id: 'fold.foldComments', label: t('cmd.foldBlockComments'), category: t('cmd.category.fold'), run() { bridge.runAction('editor.foldAllBlockComments'); close() } },
        { id: 'fold.level1', label: t('cmd.foldLevel1'), category: t('cmd.category.fold'), run() { bridge.runAction('editor.foldLevel1'); close() } },
        { id: 'fold.level2', label: t('cmd.foldLevel2'), category: t('cmd.category.fold'), run() { bridge.runAction('editor.foldLevel2'); close() } },
        { id: 'fold.level3', label: t('cmd.foldLevel3'), category: t('cmd.category.fold'), run() { bridge.runAction('editor.foldLevel3'); close() } },
      )
    }

    // ── Debug ───────────────────────────────────────────────────
    if (hasProject) {
      cmds.push(
        { id: 'debug.start', label: t('cmd.startDebugging'), category: t('cmd.category.debug'), hint: 'F5', run() { window.dispatchEvent(new CustomEvent('debugger:start')); close() } },
        { id: 'debug.stop', label: t('cmd.stopDebugging'), category: t('cmd.category.debug'), hint: '⇧F5', run() { window.dispatchEvent(new CustomEvent('debugger:stop')); close() } },
        { id: 'debug.breakpoint', label: t('cmd.toggleBreakpoint'), category: t('cmd.category.debug'), hint: 'F9', run() { window.dispatchEvent(new CustomEvent('debugger:toggle-breakpoint')); close() } },
        { id: 'debug.stepOver', label: t('cmd.stepOver'), category: t('cmd.category.debug'), hint: 'F10', run() { window.dispatchEvent(new CustomEvent('debugger:step-over')); close() } },
        { id: 'debug.stepInto', label: t('cmd.stepInto'), category: t('cmd.category.debug'), hint: 'F11', run() { window.dispatchEvent(new CustomEvent('debugger:step-into')); close() } },
        { id: 'debug.stepOut', label: t('cmd.stepOut'), category: t('cmd.category.debug'), hint: '⇧F11', run() { window.dispatchEvent(new CustomEvent('debugger:step-out')); close() } },
      )
    }

    // ── Preferences ─────────────────────────────────────────────
    cmds.push(
      { id: 'pref.settings', label: t('cmd.openSettings'), category: t('cmd.category.preferences'), hint: '⌘,', run() { useLayoutStore.getState().setViewMode('settings'); close() } },
      { id: 'pref.formatOnSave', label: t('cmd.toggleFormatOnSave'), category: t('cmd.category.preferences'), hint: useSettingsStore.getState().formatOnSave ? 'ON' : 'OFF', run() {
        const { formatOnSave, setFormatOnSave } = useSettingsStore.getState()
        setFormatOnSave(!formatOnSave)
        close()
      }},
    )

    // ── Navigation ──────────────────────────────────────────────
    cmds.push(
      { id: 'nav.backToChat', label: t('cmd.backToChat'), category: t('cmd.category.navigation'), run() { useLayoutStore.getState().goBack(); close() } },
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
              placeholder={currentProject ? `${t('menu.commandPalette').replace('\u2026','')} — ${currentProject.name}` : t('menu.commandPalette').replace('\u2026','')}
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
              <Box px={3} py={3} color={tokens.colors.text.placeholder}>{t('common.noResults')}</Box>
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
