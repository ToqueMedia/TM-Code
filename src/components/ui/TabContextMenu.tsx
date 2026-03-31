import React, { useEffect, useMemo, useState } from 'react'
import { useEditorRepository } from '../../stores/editorStore'
import { useProjectStore } from '../../stores/projectStore'
import ContextMenuOverlay, { type ContextMenuItem } from './ContextMenuOverlay'
import { t } from '@/i18n'

interface OpenEventDetail {
  x: number
  y: number
  path: string | null
}

// Closed-tabs stack — fed by the `tab:closed` event emitted from editorStore.closeFile
const closedTabsStack: string[] = []
const MAX_CLOSED_STACK = 20

function pushClosedTab(path: string) {
  const idx = closedTabsStack.indexOf(path)
  if (idx !== -1) closedTabsStack.splice(idx, 1)
  closedTabsStack.push(path)
  if (closedTabsStack.length > MAX_CLOSED_STACK) closedTabsStack.shift()
}

function getLastClosedTab(): string | undefined {
  return closedTabsStack.pop()
}

// Auto-track ALL tab closes (X button, ⌘W, context menu, closeAllFiles, etc.)
window.addEventListener('tab:closed', ((e: CustomEvent<{ path: string }>) => {
  if (e.detail?.path) pushClosedTab(e.detail.path)
}) as EventListener)

export default function TabContextMenu(): React.ReactElement | null {
  const closeFile = useEditorRepository(s => s.closeFile)
  const closeAllFiles = useEditorRepository(s => s.closeAllFiles)
  const openFiles = useEditorRepository(s => s.openFiles)
  const pinFile = useEditorRepository(s => s.pinFile)
  const splitEditor = useEditorRepository(s => s.splitEditor)
  const openFile = useEditorRepository(s => s.openFile)
  const projectPath = useProjectStore(s => s.currentProject?.path)

  const [isOpen, setIsOpen] = useState(false)
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [targetPath, setTargetPath] = useState<string | null>(null)

  function handleOpenEvent(e: Event): void {
    const ce = e as CustomEvent<OpenEventDetail>
    const d = ce.detail
    if (!d) return
    setTargetPath(d.path || null)
    setCoords({ x: d.x, y: d.y })
    setIsOpen(true)
  }

  function runClose(): void {
    if (targetPath) closeFile(targetPath)
    setIsOpen(false)
  }

  function runCloseOthers(): void {
    if (!targetPath) return setIsOpen(false)
    openFiles.forEach(f => {
      if (f.path !== targetPath) closeFile(f.path)
    })
    setIsOpen(false)
  }

  function runCloseToRight(): void {
    if (!targetPath) return setIsOpen(false)
    const idx = openFiles.findIndex(f => f.path === targetPath)
    if (idx === -1) return setIsOpen(false)
    for (let i = idx + 1; i < openFiles.length; i++) {
      closeFile(openFiles[i].path)
    }
    setIsOpen(false)
  }

  function runCloseSaved(): void {
    openFiles.forEach(f => {
      if (!f.isDirty) closeFile(f.path)
    })
    setIsOpen(false)
  }

  function runCloseAll(): void {
    closeAllFiles()
    setIsOpen(false)
  }

  function runPin(): void {
    if (targetPath) pinFile(targetPath)
    setIsOpen(false)
  }

  function runSplitRight(): void {
    splitEditor()
    setIsOpen(false)
  }

  function runReopenClosed(): void {
    const last = getLastClosedTab()
    if (last) openFile(last).catch(() => {})
    setIsOpen(false)
  }

  function runCopyPath(): void {
    if (targetPath) navigator.clipboard.writeText(targetPath).catch(() => {})
    setIsOpen(false)
  }

  function runCopyRelativePath(): void {
    if (targetPath && projectPath) {
      const rel = targetPath.startsWith(projectPath) ? targetPath.slice(projectPath.length + 1) : targetPath
      navigator.clipboard.writeText(rel).catch(() => {})
    }
    setIsOpen(false)
  }

  async function runRevealInFinder(): Promise<void> {
    if (targetPath) {
      try {
        const opener = await import('@tauri-apps/plugin-opener')
        try { await opener.revealItemInDir(targetPath) } catch {
          const dir = targetPath.substring(0, Math.max(0, targetPath.lastIndexOf('/')))
          await opener.openPath(dir)
        }
      } catch {}
    }
    setIsOpen(false)
  }

  const targetFile = openFiles.find(f => f.path === targetPath)
  const isPreview = targetFile?.isPreview

  const items = useMemo(function buildItems(): ContextMenuItem[] {
    return [
      { label: t('tab.close'), hint: '⌘W', action: runClose },
      { label: t('tab.closeOthers'), action: runCloseOthers },
      { label: t('tab.closeToRight'), action: runCloseToRight },
      { label: t('tab.closeSaved'), action: runCloseSaved },
      { label: t('tab.closeAll'), action: runCloseAll },
      { label: '', separator: true },
      { label: t('tab.reopenClosed'), hint: '⌘⇧T', action: runReopenClosed },
      { label: '', separator: true },
      { label: isPreview ? t('tab.keepOpen') : t('tab.pinTab'), action: runPin },
      { label: t('tab.splitRight'), hint: '⌘\\', action: runSplitRight },
      { label: '', separator: true },
      { label: t('tab.copyPath'), action: runCopyPath, disabled: !targetPath },
      { label: t('tab.copyRelativePath'), action: runCopyRelativePath, disabled: !targetPath || !projectPath },
      { label: '', separator: true },
      { label: t('tab.revealInFinder'), action: runRevealInFinder, disabled: !targetPath },
    ]
  }, [targetPath, openFiles, projectPath, isPreview])

  useEffect(function mount() {
    function onOpen(e: Event) { handleOpenEvent(e) }
    window.addEventListener('tabs:contextmenu:open', onOpen)
    return function cleanup() {
      window.removeEventListener('tabs:contextmenu:open', onOpen)
    }
  }, [])

  // Global Cmd+Shift+T to reopen closed tab
  useEffect(function reopenShortcut() {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey && e.shiftKey && e.key === 't') {
        e.preventDefault()
        const last = getLastClosedTab()
        if (last) openFile(last).catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openFile])

  if (!isOpen) return null

  return (
    <ContextMenuOverlay
      items={items}
      x={coords.x}
      y={coords.y}
      onClose={() => setIsOpen(false)}
    />
  )
}
