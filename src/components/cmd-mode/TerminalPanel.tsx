/**
 * TerminalPanel — multi-instance PTY terminal with tab bar.
 *
 * Architecture:
 *  - Store manages up to 3 TerminalInstance objects (id + name).
 *  - All terminals are always mounted (CSS display toggle for active/inactive).
 *  - Each SingleTerminal owns its xterm lifecycle; the store owns PTY lifecycle.
 *  - Tab bar replaces the old single header.
 *  - close() hides panel (PTYs alive); killAll() destroys everything (/exit).
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, HStack, Text } from '@chakra-ui/react'
import { FiPlus, FiX } from 'react-icons/fi'
import { invoke } from '@/utils/invokeMetrics'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { tokens } from '@/theme/tokens'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import TerminalService from '../../services/terminalService'
import { logger } from '../../utils/logger'
import { TerminalAutocomplete } from './TerminalAutocomplete'

interface TerminalPanelProps {
  projectPath: string
  widthPx: number
  onReady?: () => void
}

interface PtyOutputEvent {
  session_id: string
  data: string
}

interface PtyExitEvent {
  session_id: string
  exit_code: number
}

const TAB_BAR_HEIGHT_PX = 28

// ─── Tab Bar ────────────────────────────────────────────────────────────────

function TabItem({
  name,
  isActive,
  onClick,
  onClose,
}: {
  name: string
  isActive: boolean
  onClick: () => void
  onClose: () => void
}) {
  return (
    <Flex
      align="center"
      gap={1}
      px={2}
      h="100%"
      cursor="pointer"
      bg={isActive ? 'rgba(255,255,255,0.04)' : 'transparent'}
      borderBottom={isActive ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent'}
      _hover={{ bg: isActive ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)' }}
      onClick={onClick}
      flexShrink={0}
    >
      <Text
        fontSize="10px"
        color={isActive ? tokens.colors.text.primary : tokens.colors.text.disabled}
        fontFamily={tokens.fontFamily.mono}
        fontWeight="600"
        letterSpacing="0.04em"
        whiteSpace="nowrap"
        userSelect="none"
      >
        {name}
      </Text>
      <Box
        as="button"
        onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClose() }}
        aria-label={`Close ${name}`}
        p="1px"
        borderRadius="2px"
        color={tokens.colors.text.disabled}
        _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255,255,255,0.06)' }}
        display="flex"
        alignItems="center"
        justifyContent="center"
        transition="color 0.12s, background 0.12s"
      >
        <FiX size={11} />
      </Box>
    </Flex>
  )
}

// ─── Single Terminal Instance ────────────────────────────────────────────────

interface SingleTerminalProps {
  sessionId: string
  projectPath: string
  onReady?: () => void
}

const SingleTerminal = memo(function SingleTerminal({ sessionId, projectPath, onReady }: SingleTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const removeTerminal = useTerminalPanelStore(s => s.removeTerminal)

  // Autocomplete state
  const [completions, setCompletions] = useState<string[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const completionsRef = useRef<string[]>([])
  const selectedIdxRef = useRef(0)
  const wordRef = useRef('')
  const completionSeq = useRef(0)

  // Keep refs in sync with state for use in onData callback
  useEffect(() => { completionsRef.current = completions }, [completions])
  useEffect(() => { selectedIdxRef.current = selectedIdx }, [selectedIdx])

  const getCurrentWord = useCallback((term: Terminal): string => {
    const buffer = term.buffer.active
    const absRow = buffer.baseY + buffer.cursorY
    const line = buffer.getLine(absRow)
    if (!line) return ''
    const text = line.translateToString(true)
    const col = buffer.cursorX
    const before = text.slice(0, col)
    const lastSpace = before.lastIndexOf(' ')
    return before.slice(lastSpace + 1)
  }, [])

  const getMenuPosition = useCallback((term: Terminal): { top: number; left: number } => {
    const el = term.element
    if (!el) return { top: 0, left: 0 }
    const cellW = el.clientWidth / term.cols
    const cellH = el.clientHeight / term.rows
    const buffer = term.buffer.active
    return {
      top: (buffer.cursorY + 1) * cellH + 4,
      left: buffer.cursorX * cellW,
    }
  }, [])

  const closeMenu = useCallback(() => {
    completionSeq.current++
    setCompletions([])
    setSelectedIdx(0)
    setMenuPos(null)
    completionsRef.current = []
    selectedIdxRef.current = 0
  }, [])

  const applyCompletion = useCallback((term: Terminal, sid: string, completion: string, word: string) => {
    closeMenu()
    const backspaces = '\x7f'.repeat(word.length)
    const separator = completion.endsWith('/') ? '' : ' '
    invoke('write_to_pty', { sessionId: sid, data: backspaces + completion + separator }).catch((err) => {
      logger.warn('terminal-panel', 'applyCompletion write_to_pty failed:', err)
    })
    term.focus()
  }, [closeMenu])

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
      },
    })

    const fit = new FitAddon()
    const links = new WebLinksAddon()
    term.loadAddon(fit)
    term.loadAddon(links)

    term.open(containerRef.current)
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
      const hasMenu = completionsRef.current.length > 0

      if (data === '\t') {
        if (hasMenu) {
          const selected = completionsRef.current[selectedIdxRef.current]
          if (selected) applyCompletion(term, sessionId, selected, wordRef.current)
          return
        }
        const word = getCurrentWord(term)
        if (!word) {
          invoke('write_to_pty', { sessionId, data: '\t' }).catch(() => {})
          return
        }
        wordRef.current = word
        const seq = ++completionSeq.current
        TerminalService.shared.getCompletions(word, projectPath).then((results) => {
          if (completionSeq.current !== seq) return
          if (!results || results.length === 0) {
            invoke('write_to_pty', { sessionId, data: '\t' }).catch(() => {})
            return
          }
          if (results.length === 1) {
            applyCompletion(term, sessionId, results[0], word)
            return
          }
          setCompletions(results)
          setSelectedIdx(0)
          setMenuPos(getMenuPosition(term))
        }).catch(() => {
          if (completionSeq.current !== seq) return
          invoke('write_to_pty', { sessionId, data: '\t' }).catch(() => {})
        })
        return
      }

      if (hasMenu) {
        if (data === '\x1b[B') {
          setSelectedIdx((prev) => (prev + 1) % completionsRef.current.length)
          return
        }
        if (data === '\x1b[A') {
          setSelectedIdx((prev) => (prev - 1 + completionsRef.current.length) % completionsRef.current.length)
          return
        }
        if (data === '\r' || data === '\n') {
          const sel = completionsRef.current[selectedIdxRef.current]
          if (sel) applyCompletion(term, sessionId, sel, wordRef.current)
          return
        }
        if (data === '\x1b') {
          closeMenu()
          return
        }
        closeMenu()
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
      if (completionsRef.current.length > 0) closeMenu()
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

    // Spawn the shell
    invoke<string>('start_pty_shell', { sessionId, cwd: projectPath })
      .then(() => {
        if (disposed) return
        shellStarted = true
        onReady?.()
      })
      .catch((err) => {
        logger.error('terminal-panel', 'start_pty_shell failed:', err)
        term.writeln('\x1b[31mFailed to start shell. See logs.\x1b[0m')
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
        if (cols === lastCols && rows === lastRows) return
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          lastCols = cols
          lastRows = rows
          invoke('resize_pty', { sessionId, cols, rows }).catch(() => {})
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
      // - Tab close: removeTerminal() in the store is the trigger; React
      //   unmounts this component, this cleanup runs, but PTY is already dead.
      // - Panel close (Esc/Ctrl+X): close() hides the panel, instances stay
      //   alive, this cleanup does NOT run (components stay mounted via CSS).
      // - /exit: killAll() explicitly kills all PTYs before unmounting.
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectPath])

  return (
    <Box ref={containerRef} flex="1" minH={0} px="6px" py="4px" position="relative">
      {completions.length > 0 && menuPos && (
        <TerminalAutocomplete
          completions={completions}
          selectedIndex={selectedIdx}
          position={menuPos}
          onSelect={(item) => {
            if (termRef.current) {
              applyCompletion(termRef.current, sessionId, item, wordRef.current)
            }
          }}
        />
      )}
    </Box>
  )
})

// ─── Terminal Panel ─────────────────────────────────────────────────────────

export const TerminalPanel = memo(function TerminalPanel({ projectPath, widthPx, onReady }: TerminalPanelProps) {
  const instances = useTerminalPanelStore(s => s.instances)
  const activeInstanceId = useTerminalPanelStore(s => s.activeInstanceId)
  const addTerminal = useTerminalPanelStore(s => s.addTerminal)
  const removeTerminal = useTerminalPanelStore(s => s.removeTerminal)
  const setActiveTerminal = useTerminalPanelStore(s => s.setActiveTerminal)
  const close = useTerminalPanelStore(s => s.close)

  return (
    <Flex
      direction="column"
      width={`${widthPx}px`}
      flexShrink={0}
      height="100%"
      bg={tokens.colors.terminal.background}
      borderLeft="1px solid rgba(255,255,255,0.06)"
      minH={0}
    >
      {/* Tab bar */}
      <Flex
        height={`${TAB_BAR_HEIGHT_PX}px`}
        flexShrink={0}
        align="stretch"
        bg="rgba(0,0,0,0.3)"
        borderBottom="1px solid rgba(255,255,255,0.04)"
        data-tauri-drag-region
      >
        <HStack gap={0} h="100%" overflow="hidden" flex="1" minW={0}>
          {instances.map((inst) => (
            <TabItem
              key={inst.id}
              name={inst.name}
              isActive={inst.id === activeInstanceId}
              onClick={() => setActiveTerminal(inst.id)}
              onClose={() => removeTerminal(inst.id)}
            />
          ))}

          {/* Add terminal button */}
          {instances.length < 3 && (
            <Box
              as="button"
              onClick={addTerminal}
              aria-label="Add terminal"
              title="Add terminal (max 3)"
              p="3px"
              ml={1}
              borderRadius="3px"
              color={tokens.colors.text.disabled}
              _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255,255,255,0.06)' }}
              display="flex"
              alignItems="center"
              justifyContent="center"
              transition="color 0.12s, background 0.12s"
              flexShrink={0}
            >
              <FiPlus size={12} />
            </Box>
          )}
        </HStack>

        {/* Close panel button */}
        <Box
          as="button"
          onClick={close}
          aria-label="Close terminal panel"
          title="Close (Esc or Ctrl+X)"
          p="2px"
          mr={1}
          borderRadius="3px"
          color={tokens.colors.text.disabled}
          _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255,255,255,0.06)' }}
          display="flex"
          alignItems="center"
          justifyContent="center"
          transition="color 0.12s, background 0.12s"
          flexShrink={0}
          data-tauri-drag-region={false}
        >
          <FiX size={13} />
        </Box>
      </Flex>

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
