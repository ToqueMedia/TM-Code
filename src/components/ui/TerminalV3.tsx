import { useEffect, useCallback } from 'react';
import {
  Box,
  HStack,
  VStack,
  Text,
  Button,
  Flex,
  IconButton,
} from '@chakra-ui/react';
import {
  FiTerminal,
  FiPlay,
  FiSettings,
} from 'react-icons/fi';

import { tokens } from '@/theme/tokens';
import { useTerminalStore } from '../../stores/terminalStore';
import TerminalSession from './terminal/TerminalSession';
import TerminalTabBar from './terminal/TerminalTabBar';
import BackendProcessesSidebar from './terminal/BackendProcessesSidebar';

export default function TerminalV3() {
  const sessions = useTerminalStore(state => state.sessions);
  const activeSessionId = useTerminalStore(state => state.activeSessionId);
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
    <Flex height="100%" bg={tokens.colors.terminal.background}>
      {/* Sidebar com Backend Processes */}
      <BackendProcessesSidebar />

      {/* Main Terminal Area */}
      <Flex direction="column" flex={1}>
        {/* Terminal Tabs Header */}
        <TerminalTabBar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSetActiveSession}
          onCloseSession={handleCloseTerminal}
          onNewSession={handleNewTerminal}
        />

        {/* Terminal Content */}
        <Box flex={1} position="relative" overflow="hidden">
          {sessions.map((session) => (
            <TerminalSession
              key={session.id}
              sessionId={session.id}
              isActive={activeSessionId === session.id}
            />
          ))}

          {sessions.length === 0 && (
            <VStack
              height="100%"
              justify="center"
              gap={6}
              bg={tokens.colors.terminal.background}
            >
              <VStack gap={3}>
                <FiTerminal size={48} color={tokens.colors.text.subtle} />
                <Text fontSize="lg" color={tokens.colors.terminal.foreground}>
                  No terminal sessions
                </Text>
                <Text fontSize="sm" color={tokens.colors.text.subtle} textAlign="center">
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

        {/* Footer Bar */}
        <HStack
          bg={tokens.colors.bg.overlay}
          borderTop="1px solid"
          borderColor={tokens.colors.border.default}
          px={3}
          py={2}
          gap={3}
          justify="flex-end"
        >
          <IconButton
            size="sm"
            variant="ghost"
            aria-label="Settings"
            color={tokens.colors.text.subtle}
            _hover={{ color: tokens.colors.terminal.foreground }}
          >
            <FiSettings size={14} />
          </IconButton>
        </HStack>
      </Flex>
    </Flex>
  );
}
