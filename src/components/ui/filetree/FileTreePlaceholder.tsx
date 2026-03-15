import React from 'react';
import { Box, HStack, Text, Button } from '@chakra-ui/react';
import { FiRefreshCw } from 'react-icons/fi';
import { tokens } from '@/theme/tokens';

interface FileTreePlaceholderProps {
  variant: 'loading' | 'error' | 'empty';
  error?: string | null;
  onRefresh: () => void;
}

const FileTreePlaceholder: React.FC<FileTreePlaceholderProps> = ({ variant, error, onRefresh }) => {
  return (
    <Box p={3} bg={tokens.colors.bg.sidebar} color={tokens.colors.text.primary}>
      {variant === 'loading' && (
        <Text fontSize="sm" color={tokens.colors.text.secondary}>Loading file tree...</Text>
      )}

      {variant === 'error' && (
        <>
          <Text fontSize="sm" color={tokens.colors.accent.red}>Error: {error}</Text>
          <Button
            mt={2}
            size="xs"
            variant="outline"
            onClick={onRefresh}
            borderColor={tokens.colors.border.default}
            color={tokens.colors.text.primary}
            _hover={{ bg: tokens.colors.bg.whiteOverlay }}
          >
            <HStack gap={2}>
              <FiRefreshCw size={12} />
              <span>Retry</span>
            </HStack>
          </Button>
        </>
      )}

      {variant === 'empty' && (
        <>
          <Text fontSize="sm" color={tokens.colors.text.secondary}>No file tree available</Text>
          <Button
            mt={2}
            size="xs"
            variant="outline"
            onClick={onRefresh}
            borderColor={tokens.colors.border.default}
            color={tokens.colors.text.primary}
            _hover={{ bg: tokens.colors.bg.whiteOverlay }}
          >
            <HStack gap={2}>
              <FiRefreshCw size={12} />
              <span>Refresh</span>
            </HStack>
          </Button>
        </>
      )}
    </Box>
  );
};

export default FileTreePlaceholder;
