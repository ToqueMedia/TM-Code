import { memo } from 'react'
import { Button, Dialog } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

interface NewProjectActionsProps {
  onClose: () => void
  onSubmit: () => void
  isLoading: boolean
  isDisabled: boolean
}

function NewProjectActions({ onClose, onSubmit, isLoading, isDisabled }: NewProjectActionsProps) {
  return (
    <Dialog.Footer
      bg="bg.glass"
      borderTop="1px solid"
      borderColor="border.default"
    >
      <Button
        variant="outline"
        onClick={onClose}
        color="text.primary"
        borderColor="border.default"
        _hover={{
          bg: tokens.colors.bg.whiteOverlay,
          borderColor: tokens.colors.text.secondary,
        }}
      >
        Cancel
      </Button>
      <Button
        onClick={onSubmit}
        loading={isLoading}
        loadingText="Creating..."
        disabled={isDisabled}
        bg={tokens.colors.accent.primary}
        color={tokens.colors.text.inverse}
        _hover={{
          bg: tokens.colors.accent.primaryDark,
        }}
        _disabled={{
          bg: tokens.colors.accent.primary,
          opacity: 0.5,
          cursor: 'not-allowed',
        }}
      >
        Create Project
      </Button>
    </Dialog.Footer>
  )
}

export default memo(NewProjectActions)
