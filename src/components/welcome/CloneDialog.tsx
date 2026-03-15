import React from 'react'
import {
  Box,
  Button,
  Heading,
  Text,
  Dialog,
  Portal,
  Input,
  VStack,
} from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

const inputStyles = {
  bg: tokens.colors.bg.input,
  border: `1px solid ${tokens.colors.border.input}`,
  borderRadius: '8px',
  color: tokens.colors.text.primary,
  _focus: {
    borderColor: tokens.colors.accent.primary,
  },
}

const closeTriggerHover = {
  bg: tokens.colors.accent.redSubtle,
  color: tokens.colors.accent.red,
}

interface CloneDialogProps {
  dialog: ReturnType<typeof import('@chakra-ui/react').useDialog>
}

const CloneDialog: React.FC<CloneDialogProps> = ({ dialog }) => {
  const handleCloneProject = () => {
    dialog.setOpen(false)
  }

  return (
    <Dialog.RootProvider value={dialog}>
      <Portal>
        <Dialog.Backdrop bg={tokens.colors.dialog.backdrop} backdropFilter="blur(8px)" />
        <Dialog.Positioner>
          <Dialog.Content
            bg={tokens.colors.dialog.bg}
            border={`1px solid ${tokens.colors.dialog.border}`}
            borderRadius="16px"
            color={tokens.colors.text.primary}
            maxW="500px"
            w="90%"
          >
            <Dialog.Header>
              <Heading fontSize="24px" fontWeight="600">Clone Repository</Heading>
            </Dialog.Header>
            <Dialog.CloseTrigger asChild>
              <Button
                position="absolute"
                top="16px"
                right="16px"
                bg="none"
                border="none"
                color={tokens.colors.text.muted}
                fontSize="18px"
                cursor="pointer"
                p={1}
                borderRadius="4px"
                _hover={closeTriggerHover}
              >
                &times;
              </Button>
            </Dialog.CloseTrigger>
            <Dialog.Body pb={6}>
              <VStack gap={4} align="stretch">
                <Box>
                  <Text fontSize="14px" color={tokens.colors.text.primary} mb={2}>Repository URL</Text>
                  <Input placeholder="https://github.com/user/repo.git" {...inputStyles} />
                </Box>

                <Box>
                  <Text fontSize="14px" color={tokens.colors.text.primary} mb={2}>Local Path</Text>
                  <Input placeholder="~/Projects/repo" {...inputStyles} />
                </Box>

                <Box>
                  <Text fontSize="14px" color={tokens.colors.text.primary} mb={2}>Branch (optional)</Text>
                  <Input placeholder="main" {...inputStyles} />
                </Box>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button
                variant="outline"
                mr={3}
                onClick={() => dialog.setOpen(false)}
                border={`1px solid ${tokens.colors.border.input}`}
                _hover={{
                  bg: tokens.colors.bg.hoverSubtle,
                  color: tokens.colors.text.primary,
                }}
              >
                Cancel
              </Button>
              <Button
                colorPalette="blue"
                onClick={handleCloneProject}
                background={tokens.gradient.accentPrimary}
                color={tokens.colors.text.inverse}
                _hover={{
                  transform: 'translateY(-2px)',
                  boxShadow: tokens.shadow.dialogButton,
                }}
              >
                Clone Repository
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.RootProvider>
  )
}

export default CloneDialog
