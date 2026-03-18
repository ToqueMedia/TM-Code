import { useEffect, useCallback } from 'react';
import {
  Box,
  VStack,
  Text,
  Flex,
} from '@chakra-ui/react';
import { FiTerminal } from 'react-icons/fi';

import { tokens } from '@/theme/tokens';
import { useTerminalStore } from '../../stores/terminalStore';
import TerminalSession from './terminal/TerminalSession';
import TerminalTabBar from './terminal/TerminalTabBar';

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
    <Flex height="100%" direction="column" bg={tokens.colors.terminal.background}>
      {/* Terminal Tabs */}
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
            gap={4}
            bg={tokens.colors.terminal.background}
          >
            <Box
              p={4}
              borderRadius="12px"
              bg={tokens.colors.accent.primarySubtle}
              transition={`all ${tokens.transition.slow}`}
              _hover={{ transform: 'translateY(-3px)' }}
            >
              <FiTerminal
                size={32}
                color={tokens.colors.accent.primary}
                style={{ filter: `drop-shadow(0 0 8px ${tokens.colors.accent.primaryGlow})` }}
              />
            </Box>
            <VStack gap={1}>
              <Text fontSize="md" color={tokens.colors.text.primary} fontWeight="500">
                No terminal sessions
              </Text>
              <Text fontSize="xs" color={tokens.colors.text.muted} textAlign="center">
                Click + to create a new terminal
              </Text>
            </VStack>
          </VStack>
        )}
      </Box>
    </Flex>
  );
}
