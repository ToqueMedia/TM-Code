import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Text, VStack } from '@chakra-ui/react'
import { useEditorRepository } from '../../stores/editorStore'
import { tokens } from '../../theme/tokens'

interface OpenEventDetail {
  x: number
  y: number
  path: string | null
}

interface MenuItemSpec {
  id: string
  label: string
  onClick: () => void
}

export default function TabContextMenu(): React.ReactElement | null {
  const closeFile = useEditorRepository(function (s) { return s.closeFile })
  const closeAllFiles = useEditorRepository(function (s) { return s.closeAllFiles })
  const openFiles = useEditorRepository(function (s) { return s.openFiles })

  const [isOpen, setIsOpen] = useState(false)
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [targetPath, setTargetPath] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  function handleOpenEvent(e: Event): void {
    const ce = e as CustomEvent<OpenEventDetail>
    const d = ce.detail
    if (!d) return
    const size = getMenuSize()
    const xy = clampToViewport(d.x, d.y, size.width, size.height)
    setTargetPath(d.path || null)
    setCoords(xy)
    setIsOpen(true)
  }

  function handleBackdropMouseDown(): void {
    setIsOpen(false)
  }

  function stopPropagation(e: React.MouseEvent): void {
    e.stopPropagation()
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!isOpen) return
    if (e.key === 'Escape') setIsOpen(false)
  }

  function getMenuSize(): { width: number; height: number } {
    const el = menuRef.current
    if (!el) return { width: 220, height: 160 }
    return { width: el.offsetWidth || 220, height: el.offsetHeight || 160 }
  }

  function clampToViewport(x: number, y: number, w: number, h: number): { x: number; y: number } {
    const vw = window.innerWidth
    const vh = window.innerHeight
    let nx = x
    let ny = y
    if (nx + w > vw - 8) nx = Math.max(8, vw - w - 8)
    if (ny + h > vh - 8) ny = Math.max(8, vh - h - 8)
    return { x: nx, y: ny }
  }

  function runClose(): void {
    if (targetPath) closeFile(targetPath)
    setIsOpen(false)
  }

  function runCloseOthers(): void {
    if (!targetPath) return setIsOpen(false)
    openFiles.forEach(function (f) { if (f.path !== targetPath) closeFile(f.path) })
    setIsOpen(false)
  }

  function runCloseAll(): void {
    closeAllFiles()
    setIsOpen(false)
  }

  const items = useMemo(function buildItems(): MenuItemSpec[] {
    const list: MenuItemSpec[] = []
    list.push({ id: 'close', label: 'Close', onClick: runClose })
    list.push({ id: 'close-others', label: 'Close Others', onClick: runCloseOthers })
    list.push({ id: 'close-all', label: 'Close All', onClick: runCloseAll })
    return list
  }, [targetPath, openFiles])

  useEffect(function mount() {
    function onOpen(e: Event) { handleOpenEvent(e) }
    window.addEventListener('tabs:contextmenu:open', onOpen)
    window.addEventListener('keydown', onKeyDown)
    return function cleanup() {
      window.removeEventListener('tabs:contextmenu:open', onOpen)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isOpen, targetPath, openFiles])

  if (!isOpen) return null

  return (
    <Box 
      position="fixed" 
      inset={0} 
      zIndex={3000} 
      onMouseDown={handleBackdropMouseDown}
    >
      <Box
        ref={menuRef}
        role="menu"
        aria-label="Tab context menu"
        position="fixed"
        left={coords.x}
        top={coords.y}
        bg={tokens.colors.bg.app}
        border={`1px solid ${tokens.colors.border.subtle}`}
        borderRadius="10px"
        minW="200px"
        boxShadow={tokens.shadow.overlay}
        overflow="hidden"
        transform="scale(0.98)"
        opacity={0.0}
        animation="menuIn 120ms ease-out forwards"
        onMouseDown={stopPropagation}
      >
        <VStack align="stretch" gap={0}>
          {items.map(function render(item, idx) {
            const roundedTop = idx === 0 ? '10px' : '0px'
            const roundedBottom = idx === items.length - 1 ? '10px' : '0px'
            return (
              <Flex
                key={item.id}
                role="menuitem"
                tabIndex={0}
                justify="space-between"
                align="center"
                px={3}
                py={2.5}
                gap={3}
                cursor="default"
                bg="transparent"
                _hover={{ bg: tokens.colors.bg.activeItem }}
                _focus={{ bg: tokens.colors.bg.activeItem }}
                borderTopLeftRadius={roundedTop}
                borderTopRightRadius={roundedTop}
                borderBottomLeftRadius={roundedBottom}
                borderBottomRightRadius={roundedBottom}
                onClick={item.onClick}
                onKeyDown={function (e) { if (e.key === 'Enter') item.onClick() }}
              >
                <Text color={tokens.colors.menu.text} fontSize="sm">{item.label}</Text>
                <Box />
              </Flex>
            )
          })}
        </VStack>
      </Box>
      <style>{`@keyframes menuIn{from{opacity:0;transform:scale(0.98)}to{opacity:1;transform:scale(1)}}`}</style>
    </Box>
  )
}