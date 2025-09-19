import { useEffect, useRef } from 'react';
import { Box, HStack, Text, IconButton, Button } from '@chakra-ui/react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { FaTerminal, FaTimes, FaPlus } from 'react-icons/fa';
import '@xterm/xterm/css/xterm.css';

import { useTerminalStore } from '../../stores/terminalStore';
import TerminalService from '../../services/terminalService';

interface TerminalProps {
  sessionId: string;
  isActive: boolean;
  onClose?: () => void;
}

function TerminalSession({ sessionId, isActive, onClose }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  
  const updateSessionCwd = useTerminalStore(state => state.updateSessionCwd);
  const sessions = useTerminalStore(state => state.sessions);
  const session = sessions.find(s => s.id === sessionId);

  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;

    // Configuração do xterm.js
    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: '#1e1e1e',
        foreground: '#e6edf3',
        cursor: '#e6edf3',
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
      },
      scrollback: 1000,
      tabStopWidth: 4,
    });

    // Addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    // Abrir terminal
    terminal.open(terminalRef.current);
    
    // Ajustar tamanho após inicialização completa
    setTimeout(() => {
      try {
        if ((terminal as any)._core?._renderService?.dimensions) {
          fitAddon.fit();
        }
      } catch (error) {
        console.warn('Initial terminal fit failed:', error);
      }
    }, 50);

    // Salvar referências
    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Configurar prompt inicial
    terminal.write('\r\n$ ');

    // Configurar eventos
    setupTerminalEvents(terminal);

    // Cleanup
    return () => {
      terminal.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  // Redimensionar quando ativo
  useEffect(() => {
    if (isActive && fitAddonRef.current && xtermRef.current) {
      setTimeout(() => {
        try {
          if ((xtermRef.current as any)?._core?._renderService?.dimensions) {
            fitAddonRef.current?.fit();
          }
        } catch (error) {
          console.warn('Terminal resize failed:', error);
        }
      }, 100);
    }
  }, [isActive]);

  function setupTerminalEvents(terminal: XTerm) {
    let line = '';
    
    terminal.onData(async (data) => {
      const code = data.charCodeAt(0);
      
      if (code === 13) { // Enter
        if (line.trim()) {
          await executeCommand(line.trim());
          await TerminalService.shared.saveCommandToHistory(line.trim());
        }
        line = '';
        terminal.write('\r\n$ ');
      } else if (code === 127) { // Backspace
        if (line.length > 0) {
          line = line.slice(0, -1);
          terminal.write('\b \b');
        }
      } else if (code >= 32) { // Caracteres imprimíveis
        line += data;
        terminal.write(data);
      }
    });

    terminal.onKey(({ domEvent }) => {
      const ev = domEvent;
      
      // Ctrl+C
      if (ev.ctrlKey && ev.code === 'KeyC') {
        terminal.write('^C\r\n$ ');
        line = '';
      }
      
      // Ctrl+L (clear)
      if (ev.ctrlKey && ev.code === 'KeyL') {
        terminal.clear();
        terminal.write('$ ');
        line = '';
      }
    });
  }

  async function executeCommand(command: string) {
    if (!xtermRef.current || !session) return;

    const terminal = xtermRef.current;
    
    try {
      // Comandos internos
      if (command.startsWith('cd ')) {
        const path = command.substring(3).trim();
        try {
          const newCwd = await TerminalService.shared.changeDirectory(path);
          updateSessionCwd(sessionId, newCwd);
          return;
        } catch (error) {
          terminal.write(`\r\ncd: ${error}\r`);
          return;
        }
      }
      
      if (command === 'clear') {
        terminal.clear();
        return;
      }
      
      if (command === 'pwd') {
        terminal.write(`\r\n${session.cwd}\r`);
        return;
      }

      // Executar comando via Tauri
      terminal.write('\r\n');
      const result = await TerminalService.shared.executeCommand(command, session.cwd);
      
      if (result.stdout) {
        terminal.write(result.stdout.replace(/\n/g, '\r\n'));
      }
      
      if (result.stderr) {
        terminal.write(`\x1b[31m${result.stderr.replace(/\n/g, '\r\n')}\x1b[0m`);
      }
      
    } catch (error) {
      terminal.write(`\r\n\x1b[31mError: ${error}\x1b[0m\r`);
    }
  }

  function handleClear() {
    if (xtermRef.current) {
      xtermRef.current.clear();
      xtermRef.current.write('$ ');
    }
  }

  if (!session) {
    return (
      <Box 
        p={4} 
        textAlign="center" 
        color="fg.muted"
      >
        <Text>Terminal session not found</Text>
      </Box>
    );
  }

  return (
    <Box 
      height="100%" 
      display={isActive ? 'flex' : 'none'}
      flexDirection="column"
      bg="#1e1e1e"
    >
      {/* Header */}
      <HStack 
        px={3} 
        py={2} 
        bg="#2d2d30" 
        borderBottom="1px solid" 
        borderColor="#3c3c3c"
        gap={2}
      >
        <FaTerminal 
          size={12} 
          color="#8b949e" 
        />
        
        <Text 
          fontSize="sm" 
          color="fg.muted" 
          flex={1}
        >
          {session.name} - {session.cwd}
        </Text>
        
        <Button 
          size="xs" 
          variant="ghost" 
          onClick={handleClear}
          color="fg.muted"
          _hover={{ bg: "#37415A" }}
        >
          Clear
        </Button>
        
        {onClose && (
          <IconButton 
            size="xs" 
            variant="ghost" 
            aria-label="Close terminal"
            onClick={onClose}
            color="fg.muted"
            _hover={{ 
              bg: "#37415A",
              color: "#ff6b6b"
            }}
          >
            <FaTimes />
          </IconButton>
        )}
      </HStack>

      {/* Terminal */}
      <Box 
        ref={terminalRef} 
        flex={1}
        p={2}
        overflow="hidden"
        bg="#1e1e1e"
      />
    </Box>
  );
}

export default function Terminal() {
  const sessions = useTerminalStore(state => state.sessions);
  const activeSectionId = useTerminalStore(state => state.activeSectionId);
  const createSession = useTerminalStore(state => state.createSession);
  const removeSession = useTerminalStore(state => state.removeSession);
  const setActiveSession = useTerminalStore(state => state.setActiveSession);

  // Criar sessão inicial se não existir nenhuma
  useEffect(() => {
    if (sessions.length === 0) {
      createSession();
    }
  }, [sessions.length, createSession]);

  function handleNewTerminal() {
    createSession();
  }

  function handleCloseTerminal(sessionId: string) {
    removeSession(sessionId);
  }

  return (
    <Box 
      height="100%" 
      display="flex" 
      flexDirection="column"
      bg="#1e1e1e"
    >
      {/* Tab Bar */}
      <HStack 
        px={2} 
        py={1} 
        bg="#252526" 
        borderBottom="1px solid" 
        borderColor="#3c3c3c"
        gap={1}
        overflowX="auto"
      >
        {sessions.map((session) => (
          <Button
            key={session.id}
            size="sm"
            variant={activeSectionId === session.id ? "solid" : "ghost"}
            colorScheme={activeSectionId === session.id ? "blue" : undefined}
            onClick={() => setActiveSession(session.id)}
            minWidth="120px"
            justifyContent="space-between"
            bg={activeSectionId === session.id ? "#1e1e1e" : "#2d2d30"}
            color={activeSectionId === session.id ? "white" : "#8b949e"}
            _hover={{
              bg: activeSectionId === session.id ? "#1e1e1e" : "#37415A",
            }}
            border={activeSectionId === session.id ? "1px solid #007acc" : "1px solid transparent"}
          >
            <Text 
              fontSize="xs" 
              truncate
              maxWidth="80px"
            >
              {session.name}
            </Text>
            
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
                _hover={{ color: "#ff6b6b" }}
              >
                <FaTimes />
              </IconButton>
            )}
          </Button>
        ))}
        
        <IconButton
          size="sm"
          variant="ghost"
          aria-label="New terminal"
          onClick={handleNewTerminal}
          color="#8b949e"
          _hover={{ 
            bg: "#37415A",
            color: "white"
          }}
        >
          <FaPlus />
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
          <Box 
            p={8} 
            textAlign="center" 
            color="fg.muted"
          >
            <FaTerminal 
              size={48} 
              color="#6272a4" 
              style={{ margin: '0 auto 16px' }}
            />
            <Text mb={4}>No terminal sessions</Text>
            <Button 
              onClick={handleNewTerminal}
              colorScheme="blue"
              size="sm"
            >
              <FaPlus style={{ marginRight: '8px' }} />
              New Terminal
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}