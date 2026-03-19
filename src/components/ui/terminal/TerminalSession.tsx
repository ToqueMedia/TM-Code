import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { Box } from '@chakra-ui/react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

import { tokens } from '@/theme/tokens';
import { useTerminalStore } from '@/stores/terminalStore';
import { safeTerminalFit, createDebouncedTerminalResize } from '@/utils/terminalUtils';
import { logger } from '@/utils/logger';
import { terminalTheme } from './terminalTheme';
import { setupTerminalInput } from './terminalInput';

export interface TerminalSessionProps {
  sessionId: string;
  isActive: boolean;
}

export default function TerminalSession({ sessionId, isActive }: TerminalSessionProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const commandLockRef = useRef<boolean>(false);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isTerminalReady, setIsTerminalReady] = useState(false);
  const sessionRef = useRef<ReturnType<typeof useTerminalStore.getState>['sessions'][number] | undefined>(undefined);

  const session = useTerminalStore(useCallback(
    (state) => state.sessions.find(s => s.id === sessionId),
    [sessionId]
  ));
  sessionRef.current = session;
  const updateSessionCwd = useTerminalStore(state => state.updateSessionCwd);

  useEffect(() => {
    if (!terminalRef.current || xtermRef.current || !isActive) return;

    const terminal = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 1,
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Code", monospace',
      fontSize: 13,
      fontWeight: '300',
      fontWeightBold: '500',
      lineHeight: 1.35,
      letterSpacing: 0,
      theme: terminalTheme,
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    let initTimeout: ReturnType<typeof setTimeout> | null = null;

    try {
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(terminalRef.current);

      initTimeout = setTimeout(async () => {
        setIsTerminalReady(true);
        const success = await safeTerminalFit(terminal, fitAddon);
        if (!success) {
          logger.debug('terminal', 'Initial terminal fit deferred - terminal will resize when ready');
        }
      }, 100);

      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;

      setupTerminalInput({
        terminal,
        session,
        sessionRef,
        commandLockRef,
        xtermRef,
        updateSessionCwd,
      });
    } catch (error) {
      logger.error('terminal', 'Failed to initialize terminal', error);
    }

    return () => {
      if (initTimeout) clearTimeout(initTimeout);
      commandLockRef.current = false;
      setIsTerminalReady(false);
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      if (terminal) {
        terminal.dispose();
      }
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, isActive]);

  const debouncedResize = useMemo(() => {
    return createDebouncedTerminalResize(
      xtermRef.current,
      fitAddonRef.current,
      150
    );
  }, [xtermRef.current, fitAddonRef.current]);

  const triggerResize = useCallback(() => {
    if (isActive && isTerminalReady) {
      debouncedResize();
    }
  }, [isActive, isTerminalReady, debouncedResize]);

  useEffect(() => {
    triggerResize();
  }, [triggerResize]);

  useEffect(() => {
    const handleTerminalResize = () => {
      triggerResize();
    };

    const handlePanelResize = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { panelId } = customEvent.detail;
      if (panelId === 'bottom-panel' || panelId === 'explorer-panel') {
        triggerResize();
      }
    };

    window.addEventListener('terminalResize', handleTerminalResize);
    window.addEventListener('panelResize', handlePanelResize);

    return () => {
      window.removeEventListener('terminalResize', handleTerminalResize);
      window.removeEventListener('panelResize', handlePanelResize);
    };
  }, [triggerResize]);

  return (
    <Box
      height="100%"
      width="100%"
      display={isActive ? 'block' : 'none'}
      ref={terminalRef}
      bg={tokens.colors.terminal.background}
    />
  );
}
