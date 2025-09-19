import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { 
  Box, 
  HStack, 
  VStack,
  Text, 
  IconButton, 
  Button, 
  Flex,
  Input
} from '@chakra-ui/react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { 
  FiTerminal, 
  FiX, 
  FiPlus, 
  FiPlay,
  FiSquare,
  FiFilter,
  FiChevronRight,
  FiChevronDown,
  FiSettings
} from 'react-icons/fi';
import '@xterm/xterm/css/xterm.css';

import { useTerminalStore } from '../../stores/terminalStore';
import TerminalService from '../../services/terminalService';
import { invoke } from '@tauri-apps/api/core';

interface TerminalSessionProps {
  sessionId: string;
  isActive: boolean;
}

interface BackendProcess {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error';
  port?: number;
  pid?: number;
  icon: string;
}

function TerminalSession({ sessionId, isActive }: TerminalSessionProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const commandLockRef = useRef<boolean>(false);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const session = useTerminalStore(useCallback(
    (state) => state.sessions.find(s => s.id === sessionId), 
    [sessionId]
  ));
  const updateSessionCwd = useTerminalStore(state => state.updateSessionCwd);
  
  // Terminal theme baseado na imagem de referência
  const terminalTheme = useMemo(() => ({
    background: '#1e1e1e',
    foreground: '#d4d4d4', 
    cursor: '#ffffff',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  }), []);

  useEffect(() => {
    if (!terminalRef.current || xtermRef.current || !isActive) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "SF Mono", "Monaco", "Roboto Mono", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      letterSpacing: 0,
      theme: terminalTheme,
      scrollback: 1000,
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

      setupTerminalEvents(terminal);

    } catch (error) {
      console.error('Failed to initialize terminal:', error);
    }

    return () => {
      commandLockRef.current = false;
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      if (terminal) {
        terminal.dispose();
      }
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, terminalTheme, isActive]);

  const debouncedResize = useCallback(() => {
    if (resizeTimeoutRef.current) {
      clearTimeout(resizeTimeoutRef.current);
    }
    
    resizeTimeoutRef.current = setTimeout(() => {
      if (isActive && fitAddonRef.current && xtermRef.current?.element) {
        try {
          fitAddonRef.current.fit();
        } catch (error) {
          console.warn('Terminal resize failed:', error);
        }
      }
    }, 100);
  }, [isActive]);

  useEffect(() => {
    if (isActive) {
      debouncedResize();
    }
  }, [isActive, debouncedResize]);

  // Helper function to get display path
  async function getDisplayPath(fullPath: string): Promise<string> {
    try {
      // Try to make relative to home directory
      const homeDir = await invoke('get_home_directory') as string;
      if (fullPath.startsWith(homeDir)) {
        const relativePath = fullPath.replace(homeDir, '~');
        return relativePath.length > 25 ? '...' + relativePath.slice(-22) : relativePath;
      }
      // For other paths, truncate if too long
      return fullPath.length > 25 ? '...' + fullPath.slice(-22) : fullPath;
    } catch {
      return fullPath.length > 25 ? '...' + fullPath.slice(-22) : fullPath;
    }
  }

  // Helper function to display prompt with context
  async function displayPrompt(terminal: XTerm) {
    const cwd = session?.cwd || '~';
    const displayPath = await getDisplayPath(cwd);
    terminal.write(`\x1b[32m\x1b[1m${session?.name || 'terminal'}\x1b[0m:\x1b[34m${displayPath}\x1b[0m$ `);
  }
  
  // Handle directory change
  async function handleChangeDirectory(targetPath: string, terminal: XTerm) {
    if (!session) return;
    
    try {
      // Handle special cases
      let resolvedPath = targetPath;
      
      if (targetPath === '~' || targetPath === '') {
        resolvedPath = await invoke('get_home_directory') as string;
      } else if (targetPath === '..') {
        // Go to parent directory
        const pathParts = session.cwd.split('/').filter(part => part.length > 0);
        if (pathParts.length > 0) {
          pathParts.pop();
          resolvedPath = '/' + pathParts.join('/');
          if (resolvedPath === '/') resolvedPath = '/';
        } else {
          resolvedPath = '/';
        }
      } else if (targetPath === '.') {
        // Stay in current directory
        resolvedPath = session.cwd;
      } else if (!targetPath.startsWith('/')) {
        // Relative path
        resolvedPath = session.cwd + '/' + targetPath;
      }
      
      // Normalize path (remove double slashes, etc.)
      resolvedPath = resolvedPath.replace(/\/+/g, '/');
      if (resolvedPath.length > 1 && resolvedPath.endsWith('/')) {
        resolvedPath = resolvedPath.slice(0, -1);
      }
      
      // Check if directory exists by trying to list it
      const result = await TerminalService.shared.executeCommand('ls', resolvedPath);
      
      if (result.success) {
        // Update session working directory
        updateSessionCwd(session.id, resolvedPath);
        // Display new prompt with updated path
        await displayPrompt(terminal);
      } else {
        terminal.write(`\x1b[31mcd: no such file or directory: ${targetPath}\x1b[0m\r\n`);
        await displayPrompt(terminal);
      }
    } catch (error) {
      terminal.write(`\x1b[31mcd: ${error}\x1b[0m\r\n`);
      await displayPrompt(terminal);
    }
  }

  function setupTerminalEvents(terminal: XTerm) {
    let currentLine = '';
    
    terminal.onData(async (data) => {
      if (commandLockRef.current) return;
      
      const code = data.charCodeAt(0);
      
      if (code === 13) { // Enter
        if (currentLine.trim()) {
          await executeCommand(currentLine.trim(), terminal);
        } else {
          terminal.write('\r\n');
          await displayPrompt(terminal);
        }
        currentLine = '';
      } else if (code === 127) { // Backspace
        if (currentLine.length > 0) {
          currentLine = currentLine.slice(0, -1);
          terminal.write('\b \b');
        }
      } else if (code >= 32 && code < 127) {
        currentLine += data;
        terminal.write(data);
      }
    });

    terminal.onKey(async ({ domEvent }) => {
      const ev = domEvent;
      
      if (ev.ctrlKey && ev.code === 'KeyC') {
        terminal.write('\r\n^C\r\n');
        await displayPrompt(terminal);
        currentLine = '';
        commandLockRef.current = false;
      }
      
      if (ev.ctrlKey && ev.code === 'KeyL') {
        terminal.clear();
        await displayPrompt(terminal);
        currentLine = '';
      }
    });

    // Initial prompt with context
    displayPrompt(terminal);
  }

  // Helper function to add colors to items (no icons)
  function addColorToItems(items: string[]): string[] {
    return items.map(item => {
      // Directory coloring (assume items ending with / or common directory names)
      if (item.endsWith('/') || ['node_modules', 'src', 'public', 'dist', 'build', '.git', '.vscode'].includes(item)) {
        return `\x1b[34m${item}\x1b[0m`; // Blue color for directories
      }
      
      // File type coloring
      const ext = item.split('.').pop()?.toLowerCase();
      switch (ext) {
        case 'js': case 'jsx': case 'ts': case 'tsx':
          return `\x1b[33m${item}\x1b[0m`; // Yellow for JS/TS
        case 'json':
          return `\x1b[32m${item}\x1b[0m`; // Green for JSON
        case 'md': case 'txt':
          return `\x1b[36m${item}\x1b[0m`; // Cyan for docs
        case 'css': case 'scss': case 'sass':
          return `\x1b[35m${item}\x1b[0m`; // Magenta for styles
        case 'html': case 'htm':
          return `\x1b[31m${item}\x1b[0m`; // Red for HTML
        case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg':
          return `\x1b[95m${item}\x1b[0m`; // Bright magenta for images
        case 'gitignore':
        case 'env':
        case 'yml': case 'yaml':
          return `\x1b[90m${item}\x1b[0m`; // Gray for config files
        default:
          return item; // Default - no color
      }
    });
  }

  // Helper function to format command output
  function formatCommandOutput(command: string, output: string, terminalCols: number = 80): string {
    const trimmedCommand = command.trim().split(' ')[0];
    
    // Format ls output
    if (trimmedCommand === 'ls') {
      const items = output.trim().split(/\s+/).filter(item => item.length > 0);
      if (items.length === 0) return output;
      
      // Check if it's a long format (ls -l, ls -la, etc)
      if (command.includes('-l')) {
        return output.replace(/\n/g, '\r\n'); // Keep original format but fix line endings
      }
      
      // Add colors unless using --no-color or similar
      const enhancedItems = command.includes('--no-color') ? items : addColorToItems(items);
      
      // Calculate optimal column width
      const maxItemLength = Math.max(...items.map(item => item.length)) + 2; // Extra space for padding
      const columnWidth = Math.min(maxItemLength + 2, Math.floor(terminalCols / 3));
      const numColumns = Math.max(1, Math.min(3, Math.floor(terminalCols / columnWidth)));
      
      if (numColumns === 1) {
        // Single column format
        return enhancedItems.join('\r\n') + '\r\n';
      } else {
        // Multi-column format
        const result: string[] = [];
        for (let i = 0; i < enhancedItems.length; i += numColumns) {
          const row = enhancedItems.slice(i, i + numColumns);
          const formattedRow = row.map((item) => {
            // Remove ANSI codes for padding calculation
            const plainItem = item.replace(/\x1b\[[0-9;]*m/g, '');
            const padding = Math.max(0, columnWidth - plainItem.length);
            return item + ' '.repeat(padding);
          }).join('');
          result.push(formattedRow.trimEnd());
        }
        return result.join('\r\n') + '\r\n';
      }
    }
    
    // Format directory listing with colors
    if (['dir', 'tree'].includes(trimmedCommand)) {
      return output.replace(/\n/g, '\r\n');
    }
    
    // Default: just ensure proper line endings
    return output.replace(/\n/g, '\r\n');
  }

  async function executeCommand(command: string, terminal: XTerm) {
    if (commandLockRef.current || !session) return;
    
    commandLockRef.current = true;
    
    try {
      terminal.write('\r\n');

      // Built-in terminal commands
      if (command === 'clear') {
        terminal.clear();
        await displayPrompt(terminal);
        return;
      }
      
      // Handle cd command
      if (command.startsWith('cd ')) {
        const newPath = command.substring(3).trim();
        await handleChangeDirectory(newPath, terminal);
        return;
      } else if (command === 'cd') {
        // cd without arguments - go to home directory
        try {
          const homeDir = await invoke('get_home_directory') as string;
          await handleChangeDirectory(homeDir, terminal);
          return;
        } catch (error) {
          terminal.write(`\x1b[31mError: Could not get home directory\x1b[0m\r\n`);
          await displayPrompt(terminal);
          return;
        }
      }
      
      // Handle pwd command
      if (command === 'pwd') {
        terminal.write(`${session.cwd}\r\n`);
        await displayPrompt(terminal);
        return;
      }

      const result = await TerminalService.shared.executeCommand(
        command,
        session.cwd
      );

      if (result.success && result.stdout) {
        // Get terminal dimensions for formatting
        const terminalCols = xtermRef.current?.cols || 80;
        const formattedOutput = formatCommandOutput(command, result.stdout, terminalCols);
        terminal.write(formattedOutput);
      } else if (result.stderr) {
        const formattedError = formatCommandOutput(command, result.stderr);
        terminal.write(`\x1b[31m${formattedError}\x1b[0m`);
      }

      terminal.write('\r\n');
      await displayPrompt(terminal);

    } catch (error) {
      terminal.write(`\x1b[31mError: ${error}\x1b[0m\r\n$ `);
    } finally {
      commandLockRef.current = false;
    }
  }

  return (
    <Box
      height="100%"
      width="100%"
      display={isActive ? 'block' : 'none'}
      ref={terminalRef}
      bg="#1e1e1e"
    />
  );
}

function BackendProcessesSidebar() {
  const [isExpanded, setIsExpanded] = useState(true);
  
  // Mock data baseado na imagem
  const processes: BackendProcess[] = [
    {
      id: '1',
      name: 'next dev server',
      status: 'running',
      port: 3000,
      pid: 1234,
      icon: '⚡'
    },
    {
      id: '2', 
      name: 'node',
      status: 'stopped',
      icon: '📦'
    },
    {
      id: '3',
      name: 'zsh',
      status: 'running',
      icon: '🐚'
    },
    {
      id: '4',
      name: 'node',
      status: 'running',
      icon: '📦'
    }
  ];

  const getStatusColor = (status: BackendProcess['status']) => {
    switch (status) {
      case 'running': return 'green.400';
      case 'stopped': return 'gray.400';  
      case 'error': return 'red.400';
      default: return 'gray.400';
    }
  };

  return (
    <VStack
      width="240px"
      height="100%"
      bg="#252526"
      borderRight="1px solid"
      borderColor="#3e3e42"
      align="stretch"
      p={0}
      gap={0}
    >
      {/* Sidebar Header */}
      <HStack
        p={3}
        borderBottom="1px solid"
        borderColor="#3e3e42"
        cursor="pointer"
        onClick={() => setIsExpanded(!isExpanded)}
        _hover={{ bg: '#2a2d2e' }}
      >
        {isExpanded ? (
          <FiChevronDown size={16} color="#cccccc" />
        ) : (
          <FiChevronRight size={16} color="#cccccc" />
        )}
        <Text fontSize="sm" color="#cccccc" fontWeight="medium">
          Backend Processes
        </Text>
      </HStack>

      {/* Process List */}
      {isExpanded && (
        <VStack align="stretch" gap={0} flex={1}>
          {processes.map((process) => (
            <HStack
              key={process.id}
              p={3}
              _hover={{ bg: '#2a2d2e' }}
              cursor="pointer"
              justify="space-between"
            >
              <HStack gap={2}>
                <Text fontSize="sm">{process.icon}</Text>
                <VStack align="start" gap={0}>
                  <Text fontSize="sm" color="#cccccc">
                    {process.name}
                  </Text>
                  {process.port && (
                    <Text fontSize="xs" color="#858585">
                      Port: {process.port}
                    </Text>
                  )}
                </VStack>
              </HStack>
              
              <HStack gap={2}>
                <Box
                  width="6px"
                  height="6px" 
                  borderRadius="full"
                  bg={getStatusColor(process.status)}
                />
                {process.status === 'running' && (
                  <IconButton
                    size="xs"
                    variant="ghost"
                    aria-label="Stop"
                    color="#858585"
                    _hover={{ color: '#cccccc' }}
                    title="Stop process"
                  >
                    <FiSquare size={10} />
                  </IconButton>
                )}
              </HStack>
            </HStack>
          ))}
        </VStack>
      )}
    </VStack>
  );
}

export default function TerminalV3() {
  const [filterText, setFilterText] = useState('');
  
  const sessions = useTerminalStore(state => state.sessions);
  const activeSectionId = useTerminalStore(state => state.activeSectionId);
  const createSession = useTerminalStore(state => state.createSession);
  const removeSession = useTerminalStore(state => state.removeSession);
  const setActiveSession = useTerminalStore(state => state.setActiveSession);

  const handleNewTerminal = useCallback(() => {
    createSession();
  }, [createSession]);

  const handleCloseTerminal = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeSession(sessionId);
  }, [removeSession]);

  const handleSetActiveSession = useCallback((sessionId: string) => {
    setActiveSession(sessionId);
  }, [setActiveSession]);

  useEffect(() => {
    if (sessions.length === 0) {
      createSession('Terminal', undefined);
    }
  }, [sessions.length, createSession]);

  return (
    <Flex height="100%" bg="#1e1e1e">
      {/* Sidebar com Backend Processes */}
      <BackendProcessesSidebar />

      {/* Main Terminal Area */}
      <Flex direction="column" flex={1}>
        {/* Terminal Tabs Header */}
        <HStack
          bg="#2d2d30"
          borderBottom="1px solid" 
          borderColor="#3e3e42"
          px={3}
          py={1}
          gap={0}
          overflowX="auto"
        >
          {sessions.map((session) => {
            const isActive = activeSectionId === session.id;
            return (
              <Button
                key={session.id}
                variant="ghost"
                size="sm"
                height="36px"
                minW="120px"
                bg={isActive ? '#1e1e1e' : 'transparent'}
                color={isActive ? '#ffffff' : '#cccccc'}
                borderTop={isActive ? '2px solid' : '2px solid transparent'}
                borderTopColor={isActive ? '#0078d4' : 'transparent'}
                borderRadius="0"
                _hover={{
                  bg: isActive ? '#1e1e1e' : '#3e3e42'
                }}
                onClick={() => handleSetActiveSession(session.id)}
              >
                <HStack gap={2} flex={1}>
                  <FiTerminal size={14} />
                  <Text fontSize="xs" fontWeight="medium">
                    {session.name}
                  </Text>
                </HStack>
                
                {sessions.length > 1 && (
                  <Box
                    as="span"
                    ml={2}
                    color="inherit"
                    _hover={{ color: '#f48771' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCloseTerminal(session.id, e);
                    }}
                    cursor="pointer"
                    display="inline-flex"
                    alignItems="center"
                    p={1}
                  >
                    <FiX size={10} />
                  </Box>
                )}
              </Button>
            );
          })}
          
          <Button
            variant="ghost"
            size="sm" 
            height="36px"
            width="36px"
            color="#cccccc"
            _hover={{ bg: '#3e3e42', color: '#ffffff' }}
            onClick={handleNewTerminal}
            borderRadius="0"
          >
            <FiPlus size={14} />
          </Button>
        </HStack>

        {/* Terminal Content */}
        <Box flex={1} position="relative" overflow="hidden">
          {sessions.map((session) => (
            <TerminalSession
              key={session.id}
              sessionId={session.id}
              isActive={activeSectionId === session.id}
            />
          ))}
          
          {sessions.length === 0 && (
            <VStack 
              height="100%" 
              justify="center" 
              gap={6}
              bg="#1e1e1e"
            >
              <VStack gap={3}>
                <FiTerminal size={48} color="#858585" />
                <Text fontSize="lg" color="#cccccc">
                  No terminal sessions
                </Text>
                <Text fontSize="sm" color="#858585" textAlign="center">
                  Create a new terminal session to get started
                </Text>
              </VStack>
              
              <Button
                colorScheme="blue"
                size="md"
                onClick={handleNewTerminal}
              >
                <FiPlay style={{ marginRight: '8px' }} />
                New Terminal
              </Button>
            </VStack>
          )}
        </Box>

        {/* Filter Bar - baseado na imagem */}
        <HStack
          bg="#2d2d30"
          borderTop="1px solid"
          borderColor="#3e3e42" 
          px={3}
          py={2}
          gap={3}
        >
          <HStack flex={1}>
            <FiFilter size={14} color="#cccccc" />
            <Input
              placeholder="Filter"
              size="sm"
              bg="transparent"
              border="1px solid"
              borderColor="#3e3e42"
              color="#cccccc"
              _placeholder={{ color: '#858585' }}
              _focus={{
                borderColor: '#0078d4',
                boxShadow: 'none'
              }}
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </HStack>
          
          <IconButton
            size="sm"
            variant="ghost"
            aria-label="Settings"
            color="#858585"
            _hover={{ color: '#cccccc' }}
          >
            <FiSettings size={14} />
          </IconButton>
        </HStack>
      </Flex>
    </Flex>
  );
}