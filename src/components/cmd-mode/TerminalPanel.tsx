/**
 * TerminalPanel — multi-instance PTY terminal with tab bar.
 *
 * Architecture:
 *  - Store manages up to 5 TerminalInstance objects (id + name).
 *  - All terminals are always mounted (CSS display toggle for active/inactive).
 *  - Each SingleTerminal owns its xterm lifecycle; the store owns PTY lifecycle.
 *  - Tab bar replaces the old single header.
 *  - close() hides panel (PTYs alive); killAll() destroys everything (/exit).
 *  - Right-click context menu on tabs: Rename, Close, Close All.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, HStack, Text, Input } from '@chakra-ui/react'
import { FiPlus } from 'react-icons/fi'
import { invoke } from '@/utils/invokeMetrics'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { tokens } from '@/theme/tokens'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { logger } from '../../utils/logger'
import { TerminalAutocomplete } from './TerminalAutocomplete'
import { useTerminalAutocomplete } from './useTerminalAutocomplete'

interface TerminalPanelProps {
  projectPath: string
  widthPx: number
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

// ─── Tab Bar ────────────────────────────────────────────────────────────────

// ─── Context Menu ────────────────────────────────────────────────────────────

interface ContextMenuState {
  x: number
  y: number
  tabId: string
  tabName: string
}

function TabContextMenu({
  x,
  y,
  tabName,
  onRename,
  onClose,
  onCloseAll,
  onCloseMenu,
}: {
  x: number
  y: number
  tabName: string
  onRename: () => void
  onClose: () => void
  onCloseAll: () => void
  onCloseMenu: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Clamp to viewport after mount
  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const nx = Math.min(x, window.innerWidth - rect.width - 4)
    const ny = Math.min(y, window.innerHeight - rect.height - 4)
    if (nx !== x || ny !== y) setPos({ x: Math.max(0, nx), y: Math.max(0, ny) })
  }, [x, y])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onCloseMenu()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onCloseMenu])

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
      <Box px={3} py={1} fontSize="11px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.text.disabled} borderBottom="1px solid rgba(255,255,255,0.06)" mb={1}>
        {tabName}
      </Box>
      <Box {...itemStyle} onClick={() => { onRename(); onCloseMenu() }}>
        Renomear
      </Box>
      <Box {...itemStyle} onClick={() => { onClose(); onCloseMenu() }}>
        Fechar
      </Box>
      <Box h="1px" bg="rgba(255,255,255,0.06)" mx={2} my={1} />
      <Box {...itemStyle} onClick={() => { onCloseAll(); onCloseMenu() }} color={tokens.colors.text.muted}>
        Fechar todas
      </Box>
    </Box>
  )
}

// ─── Tab Item ────────────────────────────────────────────────────────────────

function TabItem({
  id,
  name,
  isActive,
  onClick,
  onContextMenu,
}: {
  id: string
  name: string
  isActive: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent, tabId: string, tabName: string) => void
}) {
  return (
    <Flex
      align="center"
      px={3}
      h="100%"
      cursor="pointer"
      bg={isActive ? 'rgba(255,255,255,0.06)' : 'transparent'}
      borderBottom={isActive ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent'}
      _hover={{
        bg: isActive ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)',
      }}
      onClick={onClick}
      onContextMenu={(e: React.MouseEvent) => onContextMenu(e, id, name)}
      flexShrink={0}
      transition="background 0.15s ease, border-color 0.15s ease"
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
    </Flex>
  )
}

// ─── Single Terminal Instance ────────────────────────────────────────────────

interface SingleTerminalProps {
  sessionId: string
  projectPath: string
  onReady?: () => void
}

// Cache of active start_pty_shell invocations to prevent StrictMode concurrency races
const spawnPromises = new Map<string, Promise<string>>()

// ─── Deteção de port split-brain ─────────────────────────────────────────────
//
// Incidente real (2026-06-11): dois dev servers no MESMO número de porto em
// famílias de endereço diferentes — Vite do projeto A em `[::1]:5173` (Node
// ≥17 resolve `localhost` IPv6-first) e Vite do projeto B em `*:5173` IPv4.
// Ambos anunciam "localhost:5173"; o browser (IPv6 primeiro) abre SEMPRE o
// projeto A, e o user conclui que o painel correu o projeto errado.
//
// Quando um dev server anuncia um URL aqui no painel, sondamos as duas
// famílias do porto (Rust `check_port_split` — compara status + hash do
// corpo); conteúdos diferentes ⇒ dois servidores ⇒ aviso escrito no próprio
// xterm com os URLs desambiguados. Só display — nada é injetado no PTY.

const DEV_URL_ANNOUNCEMENT_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1?\]|0\.0\.0\.0):(\d{2,5})\//

function checkPortSplitAndWarn(term: Terminal, port: number): void {
  // Pequena folga: alguns frameworks anunciam o URL um tick antes de o
  // listener estar plenamente pronto.
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

const SingleTerminal = memo(function SingleTerminal({ sessionId, projectPath, onReady }: SingleTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Portos já sondados nesta sessão de terminal — um aviso por porto chega;
  // re-anúncios (restart do dev server) não voltam a sondar.
  const probedPortsRef = useRef<Set<number>>(new Set())
  const removeTerminal = useTerminalPanelStore(s => s.removeTerminal)

  const {
    completions,
    selectedIndex,
    menuPosition,
    isLoading,
    handleTab,
    handleKeyDown,
    selectCompletion,
    closeMenu,
  } = useTerminalAutocomplete({ sessionId, projectPath })

  // O listener de pty-output vive num effect com deps [sessionId, projectPath]
  // — o closure captura o `completions` do PRIMEIRO render (sempre []), pelo
  // que `completions.length > 0` lá dentro era perpetuamente falso e o menu
  // de autocomplete nunca fechava com output novo do shell (flicker: menu
  // pendurado por cima de um comando a correr). Ref sincronizado resolve sem
  // re-subscrever o listener a cada keystroke.
  const completionsOpenRef = useRef(false)
  useEffect(() => {
    completionsOpenRef.current = completions.length > 0
  }, [completions.length])

  // Boot xterm + PTY
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"SF Mono", "Menlo", "Consolas", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      allowProposedApi: true,
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

    // GPU renderer — must be loaded AFTER term.open() (it needs the canvas).
    // The DOM renderer (xterm's default) renders ANSI colors flat/monochrome
    // inside Tauri's WKWebView; the WebGL renderer applies the theme palette
    // correctly and gives the crisp, true-color, GPU-accelerated output of a
    // native terminal (same renderer VS Code uses). Falls back to DOM if WebGL2
    // is unavailable or the GL context is lost (disposing the addon makes xterm
    // revert to the DOM renderer automatically).
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
          term.focus()
        } catch (err) {
          logger.warn('terminal-panel', 'initial fit/focus failed:', err)
        }
      })
    })

    // Frontend → PTY: forward keystrokes with autocomplete interception
    const onDataDisposable = term.onData((data: string) => {
      if (data === '\t') {
        handleTab(term)
        return
      }

      if (handleKeyDown(term, data)) {
        return
      }

      invoke('write_to_pty', { sessionId, data }).catch((err) => {
        logger.warn('terminal-panel', 'write_to_pty failed:', err)
      })
    })

    // PTY → frontend: stream output
    let unlistenOutput: UnlistenFn | null = null
    let unlistenExit: UnlistenFn | null = null
    let disposed = false
    let shellStarted = false

    listen<PtyOutputEvent>('pty-output', (event) => {
      if (disposed) return
      if (event.payload.session_id !== sessionId) return
      term.write(event.payload.data)
      // Anúncio de dev server (Vite/Next/etc.) → sonda de split-brain do
      // porto, uma vez por porto nesta sessão.
      const announced = event.payload.data.match(DEV_URL_ANNOUNCEMENT_RE)
      if (announced) {
        const port = parseInt(announced[1], 10)
        if (port > 0 && !probedPortsRef.current.has(port)) {
          probedPortsRef.current.add(port)
          checkPortSplitAndWarn(term, port)
        }
      }
      if (completionsOpenRef.current) closeMenu()
    }).then((fn) => {
      if (disposed) fn()
      else unlistenOutput = fn
    })

    listen<PtyExitEvent>('pty-exit', (event) => {
      if (disposed) return
      if (event.payload.session_id !== sessionId) return
      // Guard: ignore pty-exit if start_pty_shell hasn't resolved yet.
      // This prevents a race where the shell dies before the frontend
      // confirms the session was created (e.g. StrictMode double-invoke).
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

    // Spawn the shell
    let p = spawnPromises.get(sessionId)
    if (!p) {
      p = invoke<string>('start_pty_shell', { sessionId, cwd: projectPath })
      spawnPromises.set(sessionId, p)
    }

    p.then(() => {
      if (disposed) return
      shellStarted = true
      onReady?.()

      // Sync PTY dimensions with frontend after shell initialization.
      // Windows' ConPTY frequently discards resize requests received before or during process
      // spawning. Forcing a resize immediately after the process has started (and a second
      // deferred resize to absorb any ConPTY engine latency) ensures perfect alignment.
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
      // Remove the failed terminal instance from the store to prevent zombie tabs
      setTimeout(() => {
        if (!disposed) {
          removeTerminal(sessionId)
        }
      }, 2000)
    })
    .finally(() => {
      // Clean up the promise reference after a short delay to ensure any synchronous unmount/remount
      // cycles during StrictMode are fully absorbed and reuse the same promise.
      setTimeout(() => {
        spawnPromises.delete(sessionId)
      }, 3000)
    })

    // ResizeObserver
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let lastCols = -1
    let lastRows = -1
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return
      try {
        fitRef.current.fit()
        const cols = termRef.current.cols
        const rows = termRef.current.rows
        if (cols <= 10 || rows <= 5) return // Guard against 0 or invalid sizes
        if (cols === lastCols && rows === lastRows) return
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          lastCols = cols
          lastRows = rows
          resizePty(cols, rows)
        }, 120)
      } catch {
        // ignored — fit can throw during mount/unmount transitions
      }
    })
    ro.observe(containerRef.current)

    return () => {
      disposed = true
      ro.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      onDataDisposable.dispose()
      if (unlistenOutput) unlistenOutput()
      if (unlistenExit) unlistenExit()
      // Do NOT kill PTY here — the store owns PTY lifecycle.
      // In StrictMode, the effect runs twice with the same sessionId.
      // start_pty_shell is idempotent (Rust): if the session already exists
      // it returns Ok without creating a duplicate. This prevents both the
      // orphaned-PTY race and Tauri callback ID errors.
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectPath])

  return (
    // data-pty-terminal: marcador que os handlers globais de teclado do
    // TerminalView usam para NÃO interceptar teclas destinadas ao shell
    // (^C/^L/^K/^U/Esc) — o helper-textarea do xterm vive dentro deste Box.
    <Box ref={containerRef} flex="1" minH={0} px="6px" py="4px" position="relative" data-pty-terminal>
      {(completions.length > 0 || isLoading) && menuPosition && (
        <TerminalAutocomplete
          completions={completions}
          selectedIndex={selectedIndex}
          position={menuPosition}
          isLoading={isLoading}
          onSelect={(item) => {
            if (termRef.current) {
              selectCompletion(termRef.current, item)
            }
          }}
        />
      )}
    </Box>
  )
})

// ─── Terminal Panel ─────────────────────────────────────────────────────────

export const TerminalPanel = memo(function TerminalPanel({ projectPath, widthPx, onReady, showBorder = true }: TerminalPanelProps) {
  const instances = useTerminalPanelStore(s => s.instances)
  const activeInstanceId = useTerminalPanelStore(s => s.activeInstanceId)
  const addTerminal = useTerminalPanelStore(s => s.addTerminal)
  const removeTerminal = useTerminalPanelStore(s => s.removeTerminal)
  const renameTerminal = useTerminalPanelStore(s => s.renameTerminal)
  const closeAll = useTerminalPanelStore(s => s.closeAll)
  const setActiveTerminal = useTerminalPanelStore(s => s.setActiveTerminal)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  // Inline rename state
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
    // Focus the input after render
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

  // Keyboard shortcuts for terminal management
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // O painel continua MONTADO quando escondido (close() é display:none
      // para manter os PTYs vivos) — sem este guard, Ctrl+T/W no prompt do
      // chat criava/MATAVA terminais invisíveis com o painel fechado.
      if (!useTerminalPanelStore.getState().isOpen) return
      const isCtrl = e.ctrlKey || e.metaKey

      // Ctrl+T: Add new terminal
      if (isCtrl && e.key === 't') {
        e.preventDefault()
        if (instances.length < 5) {
          addTerminal()
        }
        return
      }

      // Ctrl+W: Close active terminal
      if (isCtrl && e.key === 'w') {
        e.preventDefault()
        if (activeInstanceId) {
          removeTerminal(activeInstanceId)
        }
        return
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: Navigate terminals
      if (isCtrl && e.key === 'Tab' && instances.length > 1) {
        e.preventDefault()
        const currentIndex = instances.findIndex(i => i.id === activeInstanceId)
        if (currentIndex === -1) return

        const nextIndex = e.shiftKey
          ? (currentIndex - 1 + instances.length) % instances.length
          : (currentIndex + 1) % instances.length

        setActiveTerminal(instances[nextIndex].id)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [instances, activeInstanceId, addTerminal, removeTerminal, setActiveTerminal])

  return (
    <Flex
      direction="column"
      width={`${widthPx}px`}
      flexShrink={0}
      height="100%"
      bg={tokens.colors.terminal.background}
      borderLeft={showBorder ? '1px solid rgba(255,255,255,0.08)' : 'none'}
      minH={0}
    >
      {/* Tab bar */}
      <Flex
        height={`${TAB_BAR_HEIGHT_PX}px`}
        flexShrink={0}
        align="stretch"
        bg="rgba(0,0,0,0.25)"
        borderBottom="1px solid rgba(255,255,255,0.05)"
        data-tauri-drag-region
      >
        <HStack gap={0} h="100%" overflow="hidden" flex="1" minW={0}>
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
                onContextMenu={handleContextMenu}
              />
            )
          )}

          {/* Add terminal button */}
          {instances.length < 5 && (
            <Box
              as="button"
              onClick={addTerminal}
              aria-label="Add terminal"
              title={`Add terminal (Ctrl+T) · ${instances.length}/5`}
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
            >
              <FiPlus size={13} />
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
      </Flex>

      {/* Context menu */}
      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          tabName={contextMenu.tabName}
          onRename={handleRenameStart}
          onClose={() => { removeTerminal(contextMenu.tabId); handleCloseMenu() }}
          onCloseAll={closeAll}
          onCloseMenu={handleCloseMenu}
        />
      )}

      {/* All terminals — only the active one is visible. Inactive terminals
          are kept alive (PTY running, xterm mounted) so tab switching is
          instant and background pty-exit events are still received. */}
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
              onReady={inst.id === activeInstanceId ? onReady : undefined}
            />
          </Box>
        ))}
      </Box>
    </Flex>
  )
})
