/**
 * TerminalPanel — multi-instance PTY terminal with tab bar.
 *
 * The shell owns the keyboard. Tab, Esc, Ctrl+W/T/C/L and arrow keys go
 * to the PTY (zsh/vim/fzf/less). The UI only adds chrome around that:
 * tabs, resize, copy/paste, and a port-split warning on localhost URLs.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, HStack, Text, Input } from '@chakra-ui/react'
import { VscAdd, VscChromeClose } from 'react-icons/vsc'
import { invoke } from '@/utils/invokeMetrics'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { logger } from '../../utils/logger'

interface TerminalPanelProps {
  projectPath: string
  onReady?: () => void
  showBorder?: boolean
}

interface PtyOutputEvent {
  session_id: string
  data: string
}

interface PtyExitEvent {
  session_id: string
  exit_code: number
}

interface InteractiveShellInfo {
  kind: string
  commandStyle: string
  platform: string
  warning?: string | null
}

const TAB_BAR_HEIGHT_PX = 36

// ─── Context Menu ────────────────────────────────────────────────────────────

interface ContextMenuState {
  x: number
  y: number
  tabId: string
  tabName: string
}

function PopupMenu({
  x,
  y,
  header,
  items,
  onClose,
}: {
  x: number
  y: number
  header?: string
  items: Array<{ label: string; onClick: () => void; muted?: boolean; disabled?: boolean }>
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const nx = Math.min(x, window.innerWidth - rect.width - 4)
    const ny = Math.min(y, window.innerHeight - rect.height - 4)
    if (nx !== x || ny !== y) setPos({ x: Math.max(0, nx), y: Math.max(0, ny) })
  }, [x, y])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const itemStyle = {
    px: 3,
    py: 1.5,
    fontSize: '12px',
    fontFamily: tokens.fontFamily.mono,
    cursor: 'pointer',
    color: tokens.colors.text.primary,
    _hover: { bg: 'rgba(254,16,99,0.15)' },
    transition: 'background 0.1s ease',
    whiteSpace: 'nowrap' as const,
  }

  return (
    <Box
      ref={menuRef}
      position="fixed"
      left={`${pos.x}px`}
      top={`${pos.y}px`}
      zIndex={10000}
      bg="rgba(30,30,30,0.95)"
      border={`1px solid ${tokens.colors.border.glass}`}
      borderRadius="6px"
      py={1}
      minW="160px"
      boxShadow="0 8px 24px rgba(0,0,0,0.5)"
      backdropFilter="blur(12px)"
      onContextMenu={(e: React.MouseEvent) => e.preventDefault()}
    >
      {header && (
        <Box px={3} py={1} fontSize="11px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.text.disabled} borderBottom="1px solid rgba(255,255,255,0.06)" mb={1}>
          {header}
        </Box>
      )}
      {items.map((item) => (
        <Box
          key={item.label}
          {...itemStyle}
          color={item.disabled ? tokens.colors.text.disabled : item.muted ? tokens.colors.text.muted : tokens.colors.text.primary}
          cursor={item.disabled ? 'default' : 'pointer'}
          onClick={() => {
            if (item.disabled) return
            item.onClick()
            onClose()
          }}
        >
          {item.label}
        </Box>
      ))}
    </Box>
  )
}

// ─── Tab Item ────────────────────────────────────────────────────────────────

function TabItem({
  id,
  name,
  isActive,
  onClick,
  onClose,
  onContextMenu,
}: {
  id: string
  name: string
  isActive: boolean
  onClick: () => void
  onClose: () => void
  onContextMenu: (e: React.MouseEvent, tabId: string, tabName: string) => void
}) {
  return (
    <Flex
      align="center"
      pl={3}
      pr={1}
      h="100%"
      cursor="pointer"
      bg={isActive ? 'rgba(255,255,255,0.06)' : 'transparent'}
      borderBottom={isActive ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent'}
      _hover={{
        bg: isActive ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)',
        '& [data-tab-close]': { opacity: 1 },
      }}
      onClick={onClick}
      onContextMenu={(e: React.MouseEvent) => onContextMenu(e, id, name)}
      flexShrink={0}
      transition="background 0.15s ease, border-color 0.15s ease"
      role="tab"
      aria-selected={isActive}
    >
      <Text
        fontSize="12px"
        color={isActive ? tokens.colors.text.primary : tokens.colors.text.muted}
        fontFamily={tokens.fontFamily.mono}
        fontWeight={isActive ? '600' : '500'}
        letterSpacing="0.03em"
        whiteSpace="nowrap"
        userSelect="none"
        transition="color 0.15s ease"
      >
        {name}
      </Text>
      <Box
        as="button"
        data-tab-close
        aria-label={t('terminal.close')}
        title={t('terminal.close')}
        opacity={isActive ? 0.7 : 0}
        ml={1}
        w="18px"
        h="18px"
        display="flex"
        alignItems="center"
        justifyContent="center"
        borderRadius="3px"
        color={tokens.colors.text.disabled}
        _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255,255,255,0.08)' }}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <VscChromeClose size={11} />
      </Box>
    </Flex>
  )
}

// ─── Single Terminal Instance ────────────────────────────────────────────────

interface SingleTerminalProps {
  sessionId: string
  projectPath: string
  isActive: boolean
  onReady?: () => void
}

const spawnPromises = new Map<string, Promise<string>>()

const DEV_URL_ANNOUNCEMENT_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1?\]|0\.0\.0\.0):(\d{2,5})\//

function checkPortSplitAndWarn(term: Terminal, port: number): void {
  setTimeout(() => {
    invoke<{ ipv4Reachable: boolean; ipv6Reachable: boolean; split: boolean }>(
      'check_port_split', { port },
    )
      .then(info => {
        if (!info.split) return
        const y = '\x1b[33m'
        const b = '\x1b[1m'
        const r = '\x1b[0m'
        term.writeln('')
        term.writeln(`${y}⚠ TM Code: porto ${b}${port}${r}${y} dividido entre DOIS servidores (IPv4 ≠ IPv6).${r}`)
        term.writeln(`${y}  "localhost:${port}" no browser pode abrir OUTRO projeto.${r}`)
        term.writeln(`${y}  Verifica qual é qual: ${b}http://127.0.0.1:${port}${r}${y} vs ${b}http://[::1]:${port}${r}`)
      })
      .catch(() => { /* sonda é best-effort */ })
  }, 600)
}

const SingleTerminal = memo(function SingleTerminal({ sessionId, projectPath, isActive, onReady }: SingleTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const probedPortsRef = useRef<Set<number>>(new Set())
  const removeTerminal = useTerminalPanelStore(s => s.removeTerminal)
  const isOpen = useTerminalPanelStore(s => s.isOpen)
  const focusNonce = useTerminalPanelStore(s => s.focusNonce)
  const [termMenu, setTermMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: tokens.fontFamily.mono,
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10000,
      allowProposedApi: true,
      // Option+letter → ESC+letter so readline/emacs bindings work on macOS.
      macOptionIsMeta: true,
      theme: {
        background: tokens.colors.terminal.background,
        foreground: tokens.colors.terminal.foreground,
        cursor: tokens.colors.accent.primary,
        cursorAccent: tokens.colors.terminal.cursorAccent,
        selectionBackground: tokens.colors.terminal.selectionBackground,
        black: tokens.colors.terminal.black,
        red: tokens.colors.terminal.red,
        green: tokens.colors.terminal.green,
        yellow: tokens.colors.terminal.yellow,
        blue: tokens.colors.terminal.blue,
        magenta: tokens.colors.terminal.magenta,
        cyan: tokens.colors.terminal.cyan,
        white: tokens.colors.terminal.white,
        brightBlack: tokens.colors.terminal.brightBlack,
        brightRed: tokens.colors.terminal.brightRed,
        brightGreen: tokens.colors.terminal.brightGreen,
        brightYellow: tokens.colors.terminal.brightYellow,
        brightBlue: tokens.colors.terminal.brightBlue,
        brightMagenta: tokens.colors.terminal.brightMagenta,
        brightCyan: tokens.colors.terminal.brightCyan,
        brightWhite: tokens.colors.terminal.brightWhite,
      },
    })

    const fit = new FitAddon()
    const links = new WebLinksAddon()
    term.loadAddon(fit)
    term.loadAddon(links)
    term.open(containerRef.current)

    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        logger.warn('terminal-panel', 'WebGL context lost — falling back to DOM renderer')
        webgl.dispose()
      })
      term.loadAddon(webgl)
    } catch (err) {
      logger.warn('terminal-panel', 'WebGL renderer unavailable, using DOM fallback:', err)
    }

    termRef.current = term
    fitRef.current = fit

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          fit.fit()
          if (isActive) term.focus()
        } catch (err) {
          logger.warn('terminal-panel', 'initial fit/focus failed:', err)
        }
      })
    })

    // Pass every keystroke (Tab, Esc, arrows, ^C, paste) straight to the shell.
    const onDataDisposable = term.onData((data: string) => {
      invoke('write_to_pty', { sessionId, data }).catch((err) => {
        logger.warn('terminal-panel', 'write_to_pty failed:', err)
      })
    })

    const onSelectionDisposable = term.onSelectionChange(() => {
      if (!term.hasSelection()) return
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel).catch(() => {})
    })

    let unlistenOutput: UnlistenFn | null = null
    let unlistenExit: UnlistenFn | null = null
    let disposed = false
    let shellStarted = false

    listen<PtyOutputEvent>('pty-output', (event) => {
      if (disposed) return
      if (event.payload.session_id !== sessionId) return
      term.write(event.payload.data)
      const announced = event.payload.data.match(DEV_URL_ANNOUNCEMENT_RE)
      if (announced) {
        const port = parseInt(announced[1], 10)
        if (port > 0 && !probedPortsRef.current.has(port)) {
          probedPortsRef.current.add(port)
          checkPortSplitAndWarn(term, port)
        }
      }
    }).then((fn) => {
      if (disposed) fn()
      else unlistenOutput = fn
    })

    listen<PtyExitEvent>('pty-exit', (event) => {
      if (disposed) return
      if (event.payload.session_id !== sessionId) return
      if (!shellStarted) return
      removeTerminal(sessionId)
    }).then((fn) => {
      if (disposed) fn()
      else unlistenExit = fn
    })

    const resizePty = (cols: number, rows: number) => {
      if (cols <= 10 || rows <= 5) return
      invoke('resize_pty', { sessionId, cols, rows }).catch((err) => {
        logger.warn('terminal-panel', 'resize_pty failed:', err)
      })
    }

    let p = spawnPromises.get(sessionId)
    if (!p) {
      p = invoke<string>('start_pty_shell', { sessionId, cwd: projectPath })
      spawnPromises.set(sessionId, p)
    }

    p.then(() => {
      if (disposed) return
      shellStarted = true
      onReady?.()
      if (termRef.current) {
        const cols = termRef.current.cols
        const rows = termRef.current.rows
        if (cols > 10 && rows > 5) {
          resizePty(cols, rows)
          setTimeout(() => {
            if (!disposed && termRef.current) {
              resizePty(termRef.current.cols, termRef.current.rows)
            }
          }, 150)
        }
      }
    })
    .catch((err) => {
      if (disposed) return
      logger.error('terminal-panel', 'start_pty_shell failed:', err)
      term.writeln('\x1b[31mFailed to start shell. Removing terminal...\x1b[0m')
      setTimeout(() => {
        if (!disposed) removeTerminal(sessionId)
      }, 2000)
    })
    .finally(() => {
      setTimeout(() => {
        spawnPromises.delete(sessionId)
      }, 3000)
    })

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let lastCols = -1
    let lastRows = -1
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return
      try {
        fitRef.current.fit()
        const cols = termRef.current.cols
        const rows = termRef.current.rows
        if (cols <= 10 || rows <= 5) return
        if (cols === lastCols && rows === lastRows) return
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          lastCols = cols
          lastRows = rows
          resizePty(cols, rows)
        }, 80)
      } catch {
        // fit can throw during mount/unmount transitions
      }
    })
    ro.observe(containerRef.current)

    return () => {
      disposed = true
      ro.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      onDataDisposable.dispose()
      onSelectionDisposable.dispose()
      if (unlistenOutput) unlistenOutput()
      if (unlistenExit) unlistenExit()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectPath])

  // Re-fit + focus when the drawer opens or this tab becomes the target.
  useEffect(() => {
    if (!isOpen || !isActive) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    requestAnimationFrame(() => {
      try {
        fit.fit()
        term.focus()
        const cols = term.cols
        const rows = term.rows
        if (cols > 10 && rows > 5) {
          invoke('resize_pty', { sessionId, cols, rows }).catch(() => {})
        }
      } catch {
        // ignored — xterm may still be attaching
      }
    })
  }, [isOpen, isActive, focusNonce, sessionId])

  const handleCopy = useCallback(() => {
    const sel = termRef.current?.getSelection()
    if (sel) void navigator.clipboard.writeText(sel).catch(() => {})
  }, [])

  const handlePaste = useCallback(() => {
    void navigator.clipboard.readText().then((text) => {
      if (!text) return
      invoke('write_to_pty', { sessionId, data: text }).catch((err) => {
        logger.warn('terminal-panel', 'paste write_to_pty failed:', err)
      })
    }).catch(() => {})
    termRef.current?.focus()
  }, [sessionId])

  const handleClear = useCallback(() => {
    termRef.current?.clear()
    termRef.current?.focus()
  }, [])

  return (
    <Box
      ref={containerRef}
      flex="1"
      minH={0}
      px="6px"
      py="4px"
      position="relative"
      data-pty-terminal
      onContextMenu={(e: React.MouseEvent) => {
        e.preventDefault()
        setTermMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {termMenu && (
        <PopupMenu
          x={termMenu.x}
          y={termMenu.y}
          onClose={() => setTermMenu(null)}
          items={[
            {
              label: t('terminal.copy'),
              onClick: handleCopy,
              disabled: !termRef.current?.hasSelection(),
            },
            { label: t('terminal.paste'), onClick: handlePaste },
            { label: t('terminal.clear'), onClick: handleClear, muted: true },
          ]}
        />
      )}
    </Box>
  )
})

// ─── Terminal Panel ─────────────────────────────────────────────────────────

export const TerminalPanel = memo(function TerminalPanel({ projectPath, onReady, showBorder = true }: TerminalPanelProps) {
  const instances = useTerminalPanelStore(s => s.instances)
  const activeInstanceId = useTerminalPanelStore(s => s.activeInstanceId)
  const addTerminal = useTerminalPanelStore(s => s.addTerminal)
  const removeTerminal = useTerminalPanelStore(s => s.removeTerminal)
  const renameTerminal = useTerminalPanelStore(s => s.renameTerminal)
  const closeAll = useTerminalPanelStore(s => s.closeAll)
  const closePanel = useTerminalPanelStore(s => s.close)
  const setActiveTerminal = useTerminalPanelStore(s => s.setActiveTerminal)

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [shellInfo, setShellInfo] = useState<InteractiveShellInfo | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    invoke<InteractiveShellInfo>('get_interactive_shell_info')
      .then(info => {
        if (!cancelled) setShellInfo(info)
      })
      .catch(err => {
        logger.warn('terminal-panel', 'get_interactive_shell_info failed:', err)
      })
    return () => { cancelled = true }
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string, tabName: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, tabId, tabName })
  }, [])

  const handleCloseMenu = useCallback(() => setContextMenu(null), [])

  const handleRenameStart = useCallback(() => {
    if (!contextMenu) return
    const tabId = contextMenu.tabId
    const tabName = contextMenu.tabName
    handleCloseMenu()
    setRenamingId(tabId)
    setRenameValue(tabName)
    requestAnimationFrame(() => renameInputRef.current?.select())
  }, [contextMenu, handleCloseMenu])

  const handleRenameCommit = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameTerminal(renamingId, renameValue.trim())
    }
    setRenamingId(null)
    setRenameValue('')
  }, [renamingId, renameValue, renameTerminal])

  const handleRenameCancel = useCallback(() => {
    setRenamingId(null)
    setRenameValue('')
  }, [])

  return (
    <Flex
      direction="column"
      width="100%"
      flex="1"
      flexShrink={0}
      height="100%"
      bg={tokens.colors.terminal.background}
      borderTop={showBorder ? `1px solid ${tokens.colors.border.panel}` : 'none'}
      minH={0}
    >
      <Flex
        height={`${TAB_BAR_HEIGHT_PX}px`}
        flexShrink={0}
        align="stretch"
        bg="rgba(0,0,0,0.25)"
        borderBottom="1px solid rgba(255,255,255,0.05)"
        data-tauri-drag-region
      >
        <HStack gap={0} h="100%" overflow="hidden" flex="1" minW={0} pl={3}>
          <Text
            fontSize="12px"
            fontWeight="500"
            color={tokens.colors.text.secondary}
            mr={2}
            flexShrink={0}
            userSelect="none"
          >
            {t('activity.terminal')}
          </Text>
          {instances.map((inst) =>
            renamingId === inst.id ? (
              <Flex key={inst.id} align="center" px={2} h="100%" flexShrink={0} data-tauri-drag-region={false}>
                <Input
                  ref={renameInputRef}
                  size="xs"
                  data-tauri-drag-region={false}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value.slice(0, 32))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameCommit()
                    if (e.key === 'Escape') handleRenameCancel()
                  }}
                  onBlur={handleRenameCommit}
                  bg="rgba(255,255,255,0.08)"
                  border={`1px solid ${tokens.colors.accent.primary}`}
                  borderRadius="4px"
                  color={tokens.colors.text.primary}
                  fontFamily={tokens.fontFamily.mono}
                  fontSize="12px"
                  h="24px"
                  px={2}
                  maxLength={32}
                  _focus={{ outline: 'none' }}
                  autoFocus
                />
              </Flex>
            ) : (
              <TabItem
                key={inst.id}
                id={inst.id}
                name={inst.name}
                isActive={inst.id === activeInstanceId}
                onClick={() => setActiveTerminal(inst.id)}
                onClose={() => removeTerminal(inst.id)}
                onContextMenu={handleContextMenu}
              />
            )
          )}

          {instances.length < 5 && (
            <Box
              as="button"
              onClick={addTerminal}
              aria-label={t('terminal.add')}
              title={`${t('terminal.add')} (Ctrl+Shift+\`) · ${instances.length}/5`}
              px="6px"
              ml={1}
              borderRadius="4px"
              color={tokens.colors.text.disabled}
              _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255,255,255,0.06)' }}
              display="flex"
              alignItems="center"
              justifyContent="center"
              gap="4px"
              transition="color 0.15s ease, background 0.15s ease"
              flexShrink={0}
              data-tauri-drag-region={false}
            >
              <VscAdd size={13} />
              <Text
                fontSize="10px"
                fontFamily={tokens.fontFamily.mono}
                color="inherit"
                userSelect="none"
              >
                {instances.length}/5
              </Text>
            </Box>
          )}
        </HStack>
        {shellInfo && (
          <Flex
            align="center"
            h="100%"
            px={2}
            flexShrink={0}
            title={shellInfo.warning || `${shellInfo.platform} · ${shellInfo.commandStyle}`}
            color={shellInfo.warning ? tokens.colors.accent.orange : tokens.colors.text.disabled}
            fontFamily={tokens.fontFamily.mono}
            fontSize="10px"
            borderLeft="1px solid rgba(255,255,255,0.05)"
            data-tauri-drag-region={false}
          >
            {shellInfo.kind}
          </Flex>
        )}
        <Box
          as="button"
          onClick={closePanel}
          aria-label={t('misc.close')}
          title={t('misc.close')}
          w="32px"
          h="100%"
          display="flex"
          alignItems="center"
          justifyContent="center"
          color={tokens.colors.text.disabled}
          flexShrink={0}
          _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255,255,255,0.06)' }}
          data-tauri-drag-region={false}
        >
          <VscChromeClose size={14} />
        </Box>
      </Flex>

      {contextMenu && (
        <PopupMenu
          x={contextMenu.x}
          y={contextMenu.y}
          header={contextMenu.tabName}
          onClose={handleCloseMenu}
          items={[
            { label: t('terminal.rename'), onClick: handleRenameStart },
            { label: t('terminal.close'), onClick: () => removeTerminal(contextMenu.tabId) },
            { label: t('terminal.closeAll'), onClick: closeAll, muted: true },
          ]}
        />
      )}

      <Box flex="1" minH={0} position="relative">
        {instances.map((inst) => (
          <Box
            key={inst.id}
            position="absolute"
            inset={0}
            display={inst.id === activeInstanceId ? 'flex' : 'none'}
            flexDirection="column"
          >
            <SingleTerminal
              sessionId={inst.id}
              projectPath={projectPath}
              isActive={inst.id === activeInstanceId}
              onReady={inst.id === activeInstanceId ? onReady : undefined}
            />
          </Box>
        ))}
      </Box>
    </Flex>
  )
})
