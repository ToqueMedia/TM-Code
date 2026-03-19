import { Box, Flex, Text, IconButton } from '@chakra-ui/react';
import { FiX, FiPlus } from 'react-icons/fi';
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
    <Flex
      direction="column"
      width="36px"
      bg={tokens.colors.bg.panel}
      borderRight={`1px solid ${tokens.colors.border.default}`}
      py={1}
      gap={0.5}
      align="center"
      flexShrink={0}
      height="100%"
      justifyContent="space-between"
    >
      {/* Session tabs */}
      <Flex direction="column" gap={0.5} align="center" overflowY="auto" flex="1"
        css={{ '&::-webkit-scrollbar': { width: '0px' } }}
      >
        {sessions.map((session, index) => {
          const isActive = activeSessionId === session.id;
          return (
            <Box
              key={session.id}
              position="relative"
              display="flex"
              alignItems="center"
              justifyContent="center"
              width="30px"
              height="30px"
              borderRadius="5px"
              cursor="pointer"
              bg={isActive ? tokens.colors.bg.whiteSubtle : 'transparent'}
              color={isActive ? tokens.colors.text.primary : tokens.colors.text.muted}
              transition={`all ${tokens.transition.fast}`}
              _hover={{
                bg: tokens.colors.bg.whiteSubtle,
                color: tokens.colors.text.primary,
                '& .term-close': { opacity: 1 },
              }}
              onClick={() => onSelectSession(session.id)}
              title={session.name}
            >
              {/* Active indicator */}
              {isActive && (
                <Box
                  position="absolute"
                  left="0"
                  top="6px"
                  bottom="6px"
                  width="2px"
                  bg={tokens.colors.accent.primary}
                  borderRadius="0 2px 2px 0"
                />
              )}

              {/* Index number or icon */}
              <Text
                fontSize="11px"
                fontWeight={isActive ? '600' : '400'}
                fontFamily={`"JetBrains Mono", ${tokens.fontFamily.mono}`}
              >
                {index + 1}
              </Text>

              {/* Close on hover — only if multiple sessions */}
              {sessions.length > 1 && (
                <Box
                  className="term-close"
                  position="absolute"
                  top="-2px"
                  right="-2px"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  width="14px"
                  height="14px"
                  borderRadius="full"
                  bg={tokens.colors.bg.panel}
                  border={`1px solid ${tokens.colors.border.subtle}`}
                  color={tokens.colors.text.muted}
                  opacity={0}
                  transition={`opacity ${tokens.transition.fast}`}
                  _hover={{ color: tokens.colors.accent.red, bg: 'rgba(248, 81, 73, 0.1)' }}
                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); onCloseSession(session.id, e); }}
                  cursor="pointer"
                >
                  <FiX size={8} />
                </Box>
              )}
            </Box>
          );
        })}
      </Flex>

      {/* New terminal button */}
      <IconButton
        variant="ghost"
        size="xs"
        aria-label="New terminal"
        title="New terminal"
        color={tokens.colors.text.muted}
        _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
        onClick={onNewSession}
        borderRadius="5px"
        width="30px"
        height="30px"
        minW="30px"
        transition={`all ${tokens.transition.fast}`}
      >
        <FiPlus size={14} />
      </IconButton>
    </Flex>
  );
}
