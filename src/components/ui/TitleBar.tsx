import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, HStack, Text, Flex, Input, Menu, Button } from '@chakra-ui/react'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useProjectStore } from '../../stores/projectStore'
import { useEditorRepository } from '../../stores/editorStore'
import QuickOpenService, { QuickOpenItem } from '../../services/quickOpenService'

function TitleBar() {
  const { currentProject, recentProjects, loadRecentProjects, openProject } = useProjectStore()
  const editorRepo = useEditorRepository()

  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(0)
  const [results, setResults] = useState<QuickOpenItem[]>([])
  const debounceRef = useRef<number | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(function onProjectChange() {
    if (currentProject && currentProject.path) {
      QuickOpenService.getInstance().initialize(currentProject.path).catch(function() {})
    } else {
      QuickOpenService.getInstance().reset().catch(function() {})
    }
  }, [currentProject])

  useEffect(function loadRecents() {
    loadRecentProjects().catch(function() {})
  }, [loadRecentProjects])

  function getCurrentWin(): WebviewWindow {
    return WebviewWindow.getCurrent()
  }
  
  function getCurrentWinV2() {
    try {
      return getCurrentWindow()
    } catch {
      return null
    }
  }

  function isMacOS(): boolean {
    try {
      // navigator.platform is more reliable for detecting macOS UI behavior
      // Fallback to userAgent if needed
      // @ts-ignore
      const plat = (navigator && (navigator.platform || navigator.userAgent)) || ''
      return /Mac/.test(String(plat))
    } catch {
      return false
    }
  }

  async function handleClose(): Promise<void> {
    try {
      const w2 = getCurrentWinV2()
      if (w2) { await w2.close() ; return }
      await getCurrentWin().close()
    } catch {}
  }

  async function handleMinimize(): Promise<void> {
    try {
      const w2 = getCurrentWinV2()
      if (w2) { await w2.minimize() ; return }
      await getCurrentWin().minimize()
    } catch {}
  }

  async function handleFullToggle(): Promise<void> {
    try {
      const w2 = getCurrentWinV2()
      if (isMacOS()) {
        if (w2) {
          const cur = await w2.isFullscreen()
          await w2.setFullscreen(!cur)
          return
        }
        const w = getCurrentWin() as any
        const fs = await w.isFullscreen?.()
        if (typeof fs === 'boolean') {
          await w.setFullscreen?.(!fs)
          return
        }
      }
      if (w2) {
        const isMax = await w2.isMaximized()
        if (isMax) { await w2.unmaximize() } else { await w2.maximize() }
        return
      }
      const w = getCurrentWin()
      const isMax = await w.isMaximized()
      if (isMax) { await w.unmaximize() } else { await w.maximize() }
    } catch {}
  }

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const v = e.target.value
    setQuery(v)
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    debounceRef.current = window.setTimeout(function run() {
      if (v.trim().length === 0) {
        setResults([])
        setHighlightIndex(0)
        return
      }
      const svc = QuickOpenService.getInstance()
      const list = svc.search(v, 100)
      setResults(list)
    }, 150)
  }

  function handleInputFocus(): void {
    setFocused(true)
  }

  function handleInputBlur(e: React.FocusEvent<HTMLInputElement>): void {
    const related = e.relatedTarget as HTMLElement | null
    const inOverlay = related && related.dataset && related.dataset.quickOpenItem === 'true'
    if (!inOverlay) {
      setFocused(false)
    }
  }

  function openPath(path: string): void {
    editorRepo.openFile(path).catch(function() {})
    setQuery('')
    setResults([])
    setFocused(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!results || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex(Math.min(highlightIndex + 1, Math.min(results.length, 20) - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex(Math.max(highlightIndex - 1, 0))
    } else if (e.key === 'Enter') {
      const visible = visibleResults
      if (visible.length > 0) {
        const item = visible[Math.max(0, Math.min(highlightIndex, visible.length - 1))]
        openPath(item.path)
      }
    } else if (e.key === 'Escape') {
      setQuery('')
      setResults([])
      setFocused(false)
    }
  }

  async function handleOpenFolder(): Promise<void> {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false, title: 'Select project directory' })
      if (selected) {
        await openProject(String(selected))
      }
    } catch {}
  }

  function handleCloneRepo(): void {
    
  }

  function handleOpenRecent(path: string): void {
    openProject(path).catch(() => {})
  }

  const visibleResults = useMemo(function pick() {
    const list = Array.isArray(results) ? results : []
    return list.slice(0, 20)
  }, [results])

  function shouldStartDrag(target: HTMLElement): boolean {
    const tag = target.tagName.toLowerCase()
    if (['input', 'textarea', 'button', 'select', 'svg', 'path'].includes(tag)) return false
    if ((target as any).dataset && ((target as any).dataset.quickOpenItem === 'true')) return false
    // Walk up the tree to avoid dragging when inside interactive elements
    let el: HTMLElement | null = target
    while (el) {
      const role = el.getAttribute && el.getAttribute('role')
      if (role === 'button' || role === 'menu' || role === 'textbox') return false
      if (el.getAttribute && el.getAttribute('data-tauri-drag-region') === 'false') return false
      el = el.parentElement
    }
    return true
  }

  async function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    try {
      if (e.button !== 0) return
      const t = e.target as HTMLElement
      if (!shouldStartDrag(t)) return
      const win = getCurrentWindow()
      await win.startDragging()
    } catch {}
  }

  useEffect(function quickOpenToggleListener() {
    function onToggle() {
      try {
        setFocused(true)
        const el = searchRef.current
        if (el) {
          el.focus()
          try { el.select() } catch {}
        }
      } catch {}
    }
    window.addEventListener('quickopen:toggle', onToggle)
    return () => window.removeEventListener('quickopen:toggle', onToggle)
  }, [])

  return (
    <Box
      className="vscode-titlebar drag-region"
      height="35px"
      bg="rgba(50, 50, 51, 0.95)"
      borderBottom="1px solid #1e1f22"
      display="flex"
      alignItems="center"
      px={2}
      position="relative"
      userSelect="none"
      backdropFilter="blur(10px)"
      data-tauri-drag-region
      onMouseDown={handleMouseDown}
    >
      <HStack
        gap={3}
        position="absolute"
        left={8}
      >
        <HStack gap={2} className="no-drag">
          <Box
            width="12px"
            height="12px"
            borderRadius="full"
            bg="#ff5f57"
            cursor="pointer"
            onClick={handleClose}
            transition="filter 0.2s"
            _hover={{ filter: 'brightness(1.1)' }}
          />
          <Box
            width="12px"
            height="12px"
            borderRadius="full"
            bg="#ffbd2e"
            cursor="pointer"
            onClick={handleMinimize}
            transition="filter 0.2s"
            _hover={{ filter: 'brightness(1.1)' }}
          />
          <Box
            width="12px"
            height="12px"
            borderRadius="full"
            bg="#28ca42"
            cursor="pointer"
            onClick={handleFullToggle}
            transition="filter 0.2s"
            _hover={{ filter: 'brightness(1.1)' }}
          />
        </HStack>

        <HStack gap={2} pl={2}>
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button
                size="xs"
                variant="ghost"
                color="#e6e6e6"
                px={2}
                height="22px"
                borderRadius="6px"
                _hover={{ bg: 'whiteAlpha.100' }}
              >
                <HStack gap={1}>
                  <Text fontSize="13px" color="#dcdcdc">{currentProject?.name || 'Select project'}</Text>
                  <Text aria-hidden>▾</Text>
                </HStack>
              </Button>
            </Menu.Trigger>
            <Menu.Positioner className="no-drag" style={{ zIndex: 10000 }}>
              <Menu.Content className="no-drag" style={{ zIndex: 10000, minWidth: '340px' }}>
                <Menu.Item value="open-folder" onClick={handleOpenFolder}>Open Folder</Menu.Item>
                <Menu.Item value="clone-repo" onClick={handleCloneRepo}>Clone Git Repository</Menu.Item>
                <Menu.Item value="connect-remote" onClick={() => {}}>Connect Remote Host</Menu.Item>
                <Menu.Separator />
                <Box px={3} py={1} color="#7d8590" fontSize="12px">Recent</Box>
                {recentProjects.slice(0, 8).map(function rp(item) {
                  const name = item.name || item.path.split('/').pop() || item.path
                  const monogram = name.trim().slice(0,2).toUpperCase()
                  return (
                    <Menu.Item value={item.path} key={item.path} onClick={function onClick() { handleOpenRecent(item.path) }}>
                      <HStack gap={3} alignItems="center">
                        <Box width="22px" height="22px" borderRadius="6px" bg="#2b2b2c" display="flex" alignItems="center" justifyContent="center" fontSize="11px" color="#d1d1d1" border="1px solid #3c3c3c">{monogram}</Box>
                        <Box>
                          <Text fontSize="13px" color="#e6e6e6">{name}</Text>
                          <Text fontSize="11px" color="#7d8590">{item.path}</Text>
                        </Box>
                      </HStack>
                    </Menu.Item>
                  )
                })}
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
        </HStack>
      </HStack>

      <Flex
        flex={1}
        justifyContent="center"
        alignItems="center"
        px={2}
      >
        <Box position="relative" width="60%" minW="320px">
          <Input
            ref={searchRef}
            type="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            value={query}
            onChange={handleQueryChange}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            onKeyDown={handleKeyDown}
            placeholder={currentProject ? `Search in ${currentProject.name}` : 'Search'}
            size="sm"
            bg="#1e1e1e"
            borderColor="#3c3c3c"
            color="#e6edf3"
            _focus={{ borderColor: '#58a6ff', boxShadow: '0 0 0 2px rgba(88, 166, 255, 0.3)' }}
            className="no-drag"
          />
          {focused && query.trim().length > 0 && visibleResults.length > 0 && (
            <Box
              position="absolute"
              top="32px"
              left={0}
              right={0}
              bg="#2d2d30"
              border="1px solid #3c3c3c"
              borderRadius="6px"
              zIndex={20}
              maxH="300px"
              overflowY="auto"
              className="no-drag"
            >
              {visibleResults.map(function item(node: QuickOpenItem, idx: number) {
                const isActive = idx === highlightIndex
                return (
                  <Box
                    key={node.path}
                    data-quick-open-item="true"
                    role="button"
                    tabIndex={0}
                    px={3}
                    py={2}
                    cursor="pointer"
                    bg={isActive ? '#094771' : 'transparent'}
                    _hover={{ bg: '#094771' }}
                    onMouseDown={function md(e) { e.preventDefault() }}
                    onClick={function onClick() { openPath(node.path) }}
                  >
                    <Text fontSize="sm" color="#e6edf3">{node.name}</Text>
                    <Text fontSize="xs" color="#858585">{node.path}</Text>
                  </Box>
                )
              })}
            </Box>
          )}
        </Box>
      </Flex>

      <Box position="absolute" right={3} width="120px" />
    </Box>
  )
}

export default TitleBar
