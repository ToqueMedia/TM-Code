import { useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, HStack, Text, IconButton, Button, VStack, Flex } from '@chakra-ui/react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { FaTerminal, FaTimes, FaPlus, FaFolder, FaPlay } from 'react-icons/fa';
import '@xterm/xterm/css/xterm.css';

import { useTerminalStore } from '../../stores/terminalStore';
import TerminalService from '../../services/terminalService';

interface TerminalSessionProps {
  sessionId: string;
  isActive: boolean;
  onClose?: () => void;
}

// Memoized TerminalSession para evitar re-renders desnecessários
function TerminalSession({ sessionId, isActive, onClose }: TerminalSessionProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const commandLockRef = useRef<boolean>(false); // 🔒 Lock para evitar race conditions
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Seletores Zustand otimizados
  const session = useTerminalStore(useCallback(
    (state) => state.sessions.find(s => s.id === sessionId), 
    [sessionId]
  ));
  const updateSessionCwd = useTerminalStore(state => state.updateSessionCwd);

  // Memoized theme para evitar recriações
  const terminalTheme = useMemo(() => ({
    background: '#0d1117',
    foreground: '#e6edf3', 
    cursor: '#58a6ff',
    cursorAccent: '#0d1117',
    selectionBackground: '#264f78',
    black: '#484f58',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  }), []);

  // 🚀 Setup terminal com cleanup robusto
  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: '"SF Mono", "Monaco", "Cascadia Code", "Roboto Mono", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      letterSpacing: 0.5,
      theme: terminalTheme,
      scrollback: 2000,
      tabStopWidth: 4,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    try {
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      
      terminal.open(terminalRef.current);
      fitAddon.fit();

      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // Welcome message
      terminal.write(`\x1b[34m┌─ ToqueMedia Studio Terminal\x1b[0m\r\n`);
      terminal.write(`\x1b[90m│ Session: ${session?.name || 'Unknown'}\x1b[0m\r\n`);
      terminal.write(`\x1b[90m│ Working Dir: ${session?.cwd || '/'}\x1b[0m\r\n`);
      terminal.write(`\x1b[34m└─\x1b[0m\r\n\r\n`);
      terminal.write('\x1b[32m$\x1b[0m ');

      setupTerminalEvents(terminal);

    } catch (error) {
      console.error('Failed to initialize terminal:', error);
    }

    return () => {
      commandLockRef.current = false;
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      terminal.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, terminalTheme, session]);

  // 🎯 Debounced resize handler
  const debouncedResize = useCallback(() => {
    if (resizeTimeoutRef.current) {
      clearTimeout(resizeTimeoutRef.current);
    }
    
    resizeTimeoutRef.current = setTimeout(() => {
      if (isActive && fitAddonRef.current && xtermRef.current) {
        try {
          fitAddonRef.current.fit();
        } catch (error) {
          console.warn('Terminal resize failed:', error);
        }
      }
    }, 150);
  }, [isActive]);

  useEffect(() => {
    debouncedResize();
  }, [isActive, debouncedResize]);

  // 🎮 Event handlers otimizados
  function setupTerminalEvents(terminal: XTerm) {
    let currentLine = '';
    
    terminal.onData(async (data) => {
      if (commandLockRef.current) return; // 🔒 Previne race conditions
      
      const code = data.charCodeAt(0);
      
      if (code === 13) { // Enter
        if (currentLine.trim()) {
          await executeCommandSafe(currentLine.trim());
        } else {
          terminal.write('\r\n\x1b[32m$\x1b[0m ');
        }
        currentLine = '';
      } else if (code === 127) { // Backspace
        if (currentLine.length > 0) {
          currentLine = currentLine.slice(0, -1);
          terminal.write('\b \b');
        }
      } else if (code >= 32 && code < 127) { // Printable characters
        currentLine += data;
        terminal.write(data);
      }
    });

    terminal.onKey(({ domEvent }) => {
      const ev = domEvent;
      
      // Ctrl+C - Interrupt
      if (ev.ctrlKey && ev.code === 'KeyC') {
        terminal.write('\r\n^C\r\n\x1b[32m$\x1b[0m ');
        currentLine = '';
        commandLockRef.current = false;
      }
      
      // Ctrl+L - Clear
      if (ev.ctrlKey && ev.code === 'KeyL') {
        terminal.clear();
        terminal.write('\x1b[32m$\x1b[0m ');
        currentLine = '';
      }

      // Ctrl+D - Exit (optional)
      if (ev.ctrlKey && ev.code === 'KeyD') {
        if (currentLine.length === 0) {
          terminal.write('\r\nexit\r\n');
          // Could trigger session close here
        }
      }
    });
  }

  // 🔒 Thread-safe command execution
  async function executeCommandSafe(command: string) {
    if (commandLockRef.current || !xtermRef.current || !session) return;
    
    commandLockRef.current = true; // 🔒 Acquire lock
    const terminal = xtermRef.current;
    
    try {
      terminal.write('\r\n');

      // Built-in commands (faster, no Tauri call)
      if (command === 'clear') {
        terminal.clear();
        return;
      }
      
      if (command === 'pwd') {
        terminal.write(`\x1b[36m${session.cwd}\x1b[0m\r\n`);
        return;
      }

      if (command.startsWith('cd ')) {
        const path = command.substring(3).trim() || '~';
        try {
          const newCwd = await TerminalService.shared.changeDirectory(path);
          updateSessionCwd(sessionId, newCwd);
          terminal.write(`\x1b[90mChanged to: \x1b[36m${newCwd}\x1b[0m\r\n`);
          return;
        } catch (error) {
          terminal.write(`\x1b[31mcd: ${error}\x1b[0m\r\n`);
          return;
        }
      }

      // Show loading indicator
      terminal.write('\x1b[90m⏳ Executing...\x1b[0m');

      // Execute via Tauri
      const result = await TerminalService.shared.executeCommand(command, session.cwd);
      
      // Clear loading indicator
      terminal.write('\r\x1b[K');
      
      if (result.stdout) {
        terminal.write(result.stdout.replace(/\n/g, '\r\n'));
      }
      
      if (result.stderr) {
        terminal.write(`\x1b[31m${result.stderr.replace(/\n/g, '\r\n')}\x1b[0m`);
      }

      if (!result.success) {
        terminal.write(`\x1b[91m[Exit code: ${result.exitCode}]\x1b[0m\r\n`);
      }

      // Save to history (async, non-blocking)
      TerminalService.shared.saveCommandToHistory(command).catch(console.warn);
      
    } catch (error) {
      terminal.write(`\r\n\x1b[31m❌ Error: ${error}\x1b[0m\r\n`);
    } finally {
      terminal.write('\x1b[32m$\x1b[0m ');
      commandLockRef.current = false; // 🔓 Release lock
    }
  }

  const handleClear = useCallback(() => {
    if (xtermRef.current && !commandLockRef.current) {
      xtermRef.current.clear();
      xtermRef.current.write('\x1b[32m$\x1b[0m ');
    }
  }, []);

  if (!session) {
    return (
      <VStack 
        height="100%" 
        justify="center" 
        color="gray.400"
        gap={3}
      >
        <FaTerminal size={48} color="#6b7280" />
        <Text fontSize="lg" fontWeight="medium">Terminal session not found</Text>
        <Text fontSize="sm" color="gray.500">Session may have been closed or is loading</Text>
      </VStack>
    );
  }

  return (
    <VStack 
      height="100%" 
      display={isActive ? 'flex' : 'none'}
      gap={0}
      bg="gray.900"
      borderRadius="md"
      overflow="hidden"
    >
      {/* Enhanced Header */}
      <HStack 
        w="100%"
        px={4} 
        py={3} 
        bg="linear-gradient(135deg, #1e1e1e 0%, #2d2d30 100%)"
        borderBottom="1px solid"
        borderColor="gray.700"
        shadow="sm"
      >
        <FaTerminal color="#58a6ff" size={14} />
        
        <VStack align="start" gap={0} flex={1}>
          <Text 
            fontSize="sm" 
            fontWeight="semibold"
            color="white"
          >
            {session.name}
          </Text>
          <HStack gap={1} fontSize="xs" color="gray.400">
            <FaFolder size={10} />
            <Text truncate maxW="200px">{session.cwd}</Text>
          </HStack>
        </VStack>
        
        <HStack gap={1}>
          <IconButton 
            size="xs" 
            variant="ghost" 
            aria-label="Clear terminal"
            onClick={handleClear}
            color="gray.400"
            _hover={{ 
              bg: "gray.700",
              color: "blue.300"
            }}
          >
            <Text fontSize="xs">Clear</Text>
          </IconButton>
          
          {onClose && (
            <IconButton 
              size="xs" 
              variant="ghost" 
              aria-label="Close terminal"
              onClick={onClose}
              color="gray.400"
              _hover={{ 
                bg: "red.900",
                color: "red.300"
              }}
            >
              <FaTimes size={10} />
            </IconButton>
          )}
        </HStack>
      </HStack>

      {/* Terminal Area */}
      <Box 
        ref={terminalRef} 
        flex={1}
        w="100%"
        p={3}
        bg="#0d1117"
        position="relative"
        _before={{
          content: '""',
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '1px',
          bg: 'linear-gradient(90deg, transparent, blue.500, transparent)',
          opacity: 0.3,
        }}
      />
    </VStack>
  );
}

// 🚀 Main Terminal Component com optimizações
export default function TerminalV2() {
  const sessions = useTerminalStore(state => state.sessions);
  const activeSectionId = useTerminalStore(state => state.activeSectionId);
  const createSession = useTerminalStore(state => state.createSession);
  const removeSession = useTerminalStore(state => state.removeSession);
  const setActiveSession = useTerminalStore(state => state.setActiveSession);

  // Memoized handlers para evitar re-renders
  const handleNewTerminal = useCallback(() => {
    createSession();
  }, [createSession]);

  const handleCloseTerminal = useCallback((sessionId: string) => {
    removeSession(sessionId);
  }, [removeSession]);

  const handleSetActiveSession = useCallback((sessionId: string) => {
    setActiveSession(sessionId);
  }, [setActiveSession]);

  // Auto-create initial session
  useEffect(() => {
    if (sessions.length === 0) {
      createSession('Main', undefined);
    }
  }, [sessions.length, createSession]);

  return (
    <Flex 
      height="100%" 
      direction="column"
      bg="#0d1117"
      borderRadius="lg"
      overflow="hidden"
      shadow="2xl"
    >
      {/* Enhanced Tab Bar */}
      <HStack 
        px={3} 
        py={2} 
        bg="linear-gradient(135deg, #161b22 0%, #21262d 100%)"
        borderBottom="1px solid"
        borderColor="gray.700"
        overflowX="auto"
        shadow="sm"
      >
        {sessions.map((session) => (
          <Button
            key={session.id}
            size="sm"
            variant="ghost"
            onClick={() => handleSetActiveSession(session.id)}
            minW="140px"
            h="36px"
            justifyContent="space-between"
            bg={activeSectionId === session.id ? "blue.900" : "transparent"}
            color={activeSectionId === session.id ? "blue.100" : "gray.400"}
            border={activeSectionId === session.id ? "1px solid" : "1px solid transparent"}
            borderColor={activeSectionId === session.id ? "blue.500" : "transparent"}
            _hover={{
              bg: activeSectionId === session.id ? "blue.800" : "gray.800",
              color: activeSectionId === session.id ? "blue.50" : "gray.200",
              borderColor: activeSectionId === session.id ? "blue.400" : "gray.600",
            }}
            position="relative"
          >
            <HStack gap={2} flex={1}>
              <Text fontSize="xs" fontWeight="medium" truncate maxW="80px">
                {session.name}
              </Text>
              {activeSectionId === session.id && (
                <Box w="6px" h="6px" bg="green.400" borderRadius="full" />
              )}
            </HStack>
            
            {sessions.length > 1 && (
              <IconButton
                size="xs"
                variant="ghost"
                aria-label="Close terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTerminal(session.id);
                }}
                ml={2}
                color="gray.500"
                _hover={{ 
                  color: "red.400",
                  bg: "red.900"
                }}
              >
                <FaTimes size={8} />
              </IconButton>
            )}
            
            {/* Active indicator */}
            {activeSectionId === session.id && (
              <Box 
                position="absolute"
                bottom="-1px"
                left="50%"
                transform="translateX(-50%)"
                w="50%"
                h="2px"
                bg="blue.400"
                borderRadius="full"
              />
            )}
          </Button>
        ))}
        
        <IconButton
          size="sm"
          variant="ghost"
          aria-label="New terminal"
          onClick={handleNewTerminal}
          color="gray.400"
          border="1px dashed"
          borderColor="gray.600"
          _hover={{ 
            bg: "blue.900",
            color: "blue.300",
            borderColor: "blue.500"
          }}
        >
          <FaPlus size={12} />
        </IconButton>
      </HStack>

      {/* Terminal Sessions */}
      <Box flex={1} position="relative">
        {sessions.map((session) => (
          <TerminalSession
            key={session.id}
            sessionId={session.id}
            isActive={activeSectionId === session.id}
            onClose={sessions.length > 1 ? () => handleCloseTerminal(session.id) : undefined}
          />
        ))}
        
        {sessions.length === 0 && (
          <VStack 
            height="100%"
            justify="center"
            gap={6}
            color="gray.400"
          >
            <VStack gap={3}>
              <FaTerminal size={64} color="#374151" />
              <Text fontSize="xl" fontWeight="semibold">No Terminal Sessions</Text>
              <Text fontSize="sm" color="gray.500" textAlign="center">
                Start coding by opening a new terminal session
              </Text>
            </VStack>
            
            <Button 
              onClick={handleNewTerminal}
              colorScheme="blue"
              size="lg"
            >
              <FaPlay style={{ marginRight: '8px' }} />
              Launch Terminal
            </Button>
          </VStack>
        )}
      </Box>
    </Flex>
  );
}