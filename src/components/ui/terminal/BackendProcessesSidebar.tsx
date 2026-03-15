import { useState } from 'react';
import {
  Box,
  HStack,
  VStack,
  Text,
  IconButton,
} from '@chakra-ui/react';
import {
  FiChevronRight,
  FiChevronDown,
  FiSquare,
} from 'react-icons/fi';

import { tokens } from '@/theme/tokens';

interface BackendProcess {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error';
  port?: number;
  pid?: number;
  icon: string;
}

const processes: BackendProcess[] = [
  { id: '1', name: 'next dev server', status: 'running', port: 3000, pid: 1234, icon: '\u26A1' },
  { id: '2', name: 'node', status: 'stopped', icon: '\uD83D\uDCE6' },
  { id: '3', name: 'zsh', status: 'running', icon: '\uD83D\uDC1A' },
  { id: '4', name: 'node', status: 'running', icon: '\uD83D\uDCE6' },
];

function getStatusColor(status: BackendProcess['status']) {
  switch (status) {
    case 'running': return 'green.400';
    case 'stopped': return 'gray.400';
    case 'error': return 'red.400';
    default: return 'gray.400';
  }
}

export default function BackendProcessesSidebar() {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <VStack
      width="240px"
      height="100%"
      bg={tokens.colors.bg.sidebar}
      borderRight="1px solid"
      borderColor={tokens.colors.border.default}
      align="stretch"
      p={0}
      gap={0}
    >
      {/* Sidebar Header */}
      <HStack
        p={3}
        borderBottom="1px solid"
        borderColor={tokens.colors.border.default}
        cursor="pointer"
        onClick={() => setIsExpanded(!isExpanded)}
        _hover={{ bg: tokens.colors.bg.tabHover }}
      >
        {isExpanded ? (
          <FiChevronDown size={16} color={tokens.colors.terminal.foreground} />
        ) : (
          <FiChevronRight size={16} color={tokens.colors.terminal.foreground} />
        )}
        <Text fontSize="sm" color={tokens.colors.terminal.foreground} fontWeight="medium">
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
              _hover={{ bg: tokens.colors.bg.tabHover }}
              cursor="pointer"
              justify="space-between"
            >
              <HStack gap={2}>
                <Text fontSize="sm">{process.icon}</Text>
                <VStack align="start" gap={0}>
                  <Text fontSize="sm" color={tokens.colors.terminal.foreground}>
                    {process.name}
                  </Text>
                  {process.port && (
                    <Text fontSize="xs" color={tokens.colors.text.subtle}>
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
                    color={tokens.colors.text.subtle}
                    _hover={{ color: tokens.colors.terminal.foreground }}
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
