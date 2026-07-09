import React from 'react';
import { Box, HStack, Text, Button } from '@chakra-ui/react';
import { VscRefresh } from 'react-icons/vsc';
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n';

interface FileTreePlaceholderProps {
  variant: 'loading' | 'error' | 'empty';
  error?: string | null;
  onRefresh: () => void;
}

const FileTreePlaceholder: React.FC<FileTreePlaceholderProps> = ({ variant, error, onRefresh }) => {
  return (
    <Box p={3} bg={tokens.colors.bg.sidebar} color={tokens.colors.text.primary}>
      {variant === 'loading' && (
        <Text fontSize="sm" color={tokens.colors.text.secondary}>{t("explorer.loadingFileTree")}</Text>
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
              <VscRefresh size={12} />
              <span>{t("explorer.retry")}</span>
            </HStack>
          </Button>
        </>
      )}

      {variant === 'empty' && (
        <>
          <Text fontSize="sm" color={tokens.colors.text.secondary}>{t("explorer.noFileTree")}</Text>
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
              <VscRefresh size={12} />
              <span>{t("view.refresh")}</span>
            </HStack>
          </Button>
        </>
      )}
    </Box>
  );
};

export default FileTreePlaceholder;
