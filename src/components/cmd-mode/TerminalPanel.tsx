/**
 * TerminalPanel — interactive PTY shell rendered with xterm.js v6.
 *
 * Architecture:
 *  - Frontend: xterm Terminal + FitAddon + WebLinksAddon.
 *  - Backend: Rust `start_pty_shell` / `write_to_pty` / `resize_pty` / `kill_pty_session`.
 *  - Multiplex: a single global `pty-output` event carries `{ session_id, data }`
 *    payloads — we filter by `session_id` so future multi-terminal support is a
 *    drop-in. `pty-exit` mirrors the same envelope.
 *
 *  Lifecycle (single source of truth = terminalPanelStore):
 *   - mount → invoke start_pty_shell → store session id → wire events
 *   - close button or store.close() → invoke kill_pty_session → unmount
 *   - unmount cleanup → store.close() (in case the parent unmounts us first)
 */
import { memo, useEffect, useRef } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { tokens } from '@/theme/tokens'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { logger } from '../../utils/logger'

interface TerminalPanelProps {
  projectPath: string
  widthPx: number
}

interface PtyOutputEvent {
  session_id: string
  data: string
}

interface PtyExitEvent {
  session_id: string
  exit_code: number
}

const HEADER_HEIGHT_PX = 28

export const TerminalPanel = memo(function TerminalPanel({ projectPath, widthPx }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const close = useTerminalPanelStore(s => s.close)
  const setSessionId = useTerminalPanelStore(s => s.setSessionId)

  // Boot xterm + PTY once on mount. The effect runs once (projectPath change is
  // handled at the parent level by remount via key).
  useEffect(() => {
    if (!containerRef.current) return

    const sessionId = crypto.randomUUID()
    sessionIdRef.current = sessionId

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

    // Initial fit — defer to next frame so the container has dimensions.
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch (err) {
        logger.warn('terminal-panel', 'initial fit failed:', err)
      }
    })

    // Frontend → PTY: forward keystrokes
    const onDataDisposable = term.onData((data: string) => {
      invoke('write_to_pty', { sessionId, data }).catch((err) => {
        logger.warn('terminal-panel', 'write_to_pty failed:', err)
      })
    })

    // PTY → frontend: stream output. Single global event channel for now;
    // filter by session id so we ignore noise from other future panels.
    let unlistenOutput: UnlistenFn | null = null
    let unlistenExit: UnlistenFn | null = null
    let disposed = false

    listen<PtyOutputEvent>('pty-output', (event) => {
      if (disposed) return
      if (event.payload.session_id !== sessionId) return
      term.write(event.payload.data)
    }).then((fn) => {
      if (disposed) {
        fn()
      } else {
        unlistenOutput = fn
      }
    })

    listen<PtyExitEvent>('pty-exit', (event) => {
      if (disposed) return
      if (event.payload.session_id !== sessionId) return
      // Shell exited (user typed `exit`, or process died) — close the panel.
      close()
    }).then((fn) => {
      if (disposed) {
        fn()
      } else {
        unlistenExit = fn
      }
    })

    // Spawn the shell. `cwd` is clamped to the project on the Rust side when
    // an active project is set (it is — `open_project` was invoked by the
    // parent CmdModeView).
    invoke<string>('start_pty_shell', { sessionId, cwd: projectPath })
      .then(() => {
        if (disposed) return
        setSessionId(sessionId)
      })
      .catch((err) => {
        logger.error('terminal-panel', 'start_pty_shell failed:', err)
        term.writeln('\x1b[31mFailed to start shell. See logs.\x1b[0m')
      })

    // ResizeObserver: keep xterm sized to its container, and inform the PTY.
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return
      try {
        fitRef.current.fit()
        const cols = termRef.current.cols
        const rows = termRef.current.rows
        invoke('resize_pty', { sessionId, cols, rows }).catch(() => {})
      } catch {
        // ignored — fit can throw during mount/unmount transitions
      }
    })
    ro.observe(containerRef.current)

    return () => {
      disposed = true
      ro.disconnect()
      onDataDisposable.dispose()
      if (unlistenOutput) unlistenOutput()
      if (unlistenExit) unlistenExit()
      // Best-effort PTY shutdown. Store.close() (called by /terminal toggle or
      // exit button) is the authoritative kill — this is just defence-in-depth
      // for the unmount-without-close-action case.
      invoke('kill_pty_session', { sessionId }).catch(() => {})
      term.dispose()
      termRef.current = null
      fitRef.current = null
      sessionIdRef.current = null
    }
  }, [projectPath, close, setSessionId])

  const folderName = projectPath.split(/[\/\\]/).filter(Boolean).pop() || projectPath

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
      {/* Header */}
      <Flex
        height={`${HEADER_HEIGHT_PX}px`}
        flexShrink={0}
        align="center"
        justify="space-between"
        px={2}
        bg="rgba(0,0,0,0.3)"
        borderBottom="1px solid rgba(255,255,255,0.04)"
      >
        <Text
          fontSize="10px"
          color={tokens.colors.text.muted}
          fontFamily={tokens.fontFamily.mono}
          fontWeight="600"
          letterSpacing="0.05em"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          terminal · {folderName}
        </Text>
        <Box
          as="button"
          onClick={close}
          aria-label="Close terminal panel"
          title="Close (Esc or /terminal)"
          p="2px"
          borderRadius="3px"
          color={tokens.colors.text.disabled}
          _hover={{ color: tokens.colors.text.primary, bg: 'rgba(255,255,255,0.06)' }}
          display="flex"
          alignItems="center"
          justifyContent="center"
          transition="color 0.12s, background 0.12s"
        >
          <FiX size={13} />
        </Box>
      </Flex>

      {/* xterm container — fills remaining height */}
      <Box ref={containerRef} flex="1" minH={0} px="6px" py="4px" />
    </Flex>
  )
})
