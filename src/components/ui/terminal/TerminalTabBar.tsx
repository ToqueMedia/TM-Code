import {
  Box,
  HStack,
  Text,
  Button,
} from '@chakra-ui/react';
import {
  FiTerminal,
  FiX,
  FiPlus,
} from 'react-icons/fi';

import { tokens } from '@/theme/tokens';

interface TerminalTab {
  id: string;
  name: string;
}

interface TerminalTabBarProps {
  sessions: TerminalTab[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string, e: React.MouseEvent) => void;
  onNewSession: () => void;
}

export default function TerminalTabBar({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewSession,
}: TerminalTabBarProps) {
  return (
    <HStack
      bg={tokens.colors.bg.overlay}
      borderBottom="1px solid"
      borderColor={tokens.colors.border.default}
      px={3}
      py={1}
      gap={0}
      overflowX="auto"
    >
      {sessions.map((session) => {
        const isActive = activeSessionId === session.id;
        return (
          <Button
            key={session.id}
            variant="ghost"
            size="sm"
            height="36px"
            minW="120px"
            bg={isActive ? tokens.colors.terminal.background : 'transparent'}
            color={isActive ? tokens.colors.terminal.cursor : tokens.colors.terminal.foreground}
            borderTop={isActive ? '2px solid' : '2px solid transparent'}
            borderTopColor={isActive ? tokens.colors.accent.blueAlt : 'transparent'}
            borderRadius="0"
            _hover={{
              bg: isActive ? tokens.colors.terminal.background : tokens.colors.border.default
            }}
            onClick={() => onSelectSession(session.id)}
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
                _hover={{ color: tokens.colors.accent.red }}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseSession(session.id, e);
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
        color={tokens.colors.terminal.foreground}
        _hover={{ bg: tokens.colors.border.default, color: tokens.colors.terminal.cursor }}
        onClick={onNewSession}
        borderRadius="0"
      >
        <FiPlus size={14} />
      </Button>
    </HStack>
  );
}
