import {
  Box,
  HStack,
  Text,
  IconButton,
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
      bg={tokens.colors.bg.panel}
      borderBottom={`1px solid ${tokens.colors.border.default}`}
      px={1}
      py={0}
      gap={0}
      overflowX="auto"
      flexShrink={0}
      height="32px"
      css={{
        '&::-webkit-scrollbar': { height: '0px' },
      }}
    >
      {sessions.map((session) => {
        const isActive = activeSessionId === session.id;
        return (
          <HStack
            key={session.id}
            gap={1.5}
            px={3}
            height="100%"
            bg={isActive ? tokens.colors.bg.app : 'transparent'}
            color={isActive ? tokens.colors.text.primary : tokens.colors.text.muted}
            cursor="pointer"
            position="relative"
            borderRadius="0"
            transition={`all ${tokens.transition.fast}`}
            _hover={{
              bg: isActive ? tokens.colors.bg.app : tokens.colors.bg.hoverSubtle,
              color: tokens.colors.text.primary,
            }}
            onClick={() => onSelectSession(session.id)}
            _after={{
              content: '""',
              position: 'absolute',
              bottom: 0,
              left: '15%',
              right: '15%',
              height: '2px',
              bg: isActive ? tokens.colors.accent.primary : 'transparent',
              borderRadius: '2px 2px 0 0',
              transition: `all ${tokens.transition.normal}`,
              boxShadow: isActive ? `0 0 6px ${tokens.colors.accent.primaryGlow}` : 'none',
            }}
          >
            <FiTerminal size={12} style={{ opacity: isActive ? 1 : 0.6, flexShrink: 0 }} />
            <Text
              fontSize="11px"
              fontWeight={isActive ? '500' : '400'}
              whiteSpace="nowrap"
              letterSpacing="-0.01em"
            >
              {session.name}
            </Text>

            {sessions.length > 1 && (
              <Box
                as="span"
                ml={0.5}
                color="inherit"
                opacity={isActive ? 0.5 : 0}
                _hover={{ opacity: 1, color: tokens.colors.accent.red }}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  onCloseSession(session.id, e);
                }}
                cursor="pointer"
                display="inline-flex"
                alignItems="center"
                transition={`all ${tokens.transition.fast}`}
                borderRadius="3px"
                p={0.5}
              >
                <FiX size={10} />
              </Box>
            )}
          </HStack>
        );
      })}

      <IconButton
        variant="ghost"
        size="xs"
        aria-label="New terminal"
        title="New terminal"
        color={tokens.colors.text.muted}
        _hover={{
          bg: tokens.colors.bg.hoverSubtle,
          color: tokens.colors.text.primary,
        }}
        onClick={onNewSession}
        borderRadius="4px"
        width="28px"
        height="28px"
        ml={0.5}
        transition={`all ${tokens.transition.fast}`}
      >
        <FiPlus size={13} />
      </IconButton>
    </HStack>
  );
}
