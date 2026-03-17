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
  bg: 'rgba(255, 255, 255, 0.05)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: '10px',
  color: tokens.colors.text.primary,
  fontSize: '13px',
  _placeholder: { color: tokens.colors.text.muted },
  _focus: {
    borderColor: tokens.colors.accent.primary,
    boxShadow: `0 0 0 1px ${tokens.colors.accent.primary}40`,
  },
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
        <Dialog.Backdrop bg="rgba(0, 0, 0, 0.75)" backdropFilter="blur(12px)" />
        <Dialog.Positioner>
          <Dialog.Content
            bg="rgba(15, 15, 15, 0.98)"
            border="1px solid rgba(254, 16, 99, 0.2)"
            borderRadius="20px"
            color={tokens.colors.text.primary}
            maxW="480px"
            w="90%"
            boxShadow="0 25px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(254, 16, 99, 0.1)"
            overflow="hidden"
            position="relative"
          >
            {/* Top gradient line */}
            <Box
              position="absolute"
              top="0"
              left="0"
              right="0"
              height="2px"
              background={`linear-gradient(90deg, transparent, ${tokens.colors.accent.primary}, transparent)`}
              opacity={0.6}
            />

            <Dialog.Header pt={7} px={7} pb={0}>
              <Heading fontSize="20px" fontWeight="700" color="white">Clone Repository</Heading>
            </Dialog.Header>

            <Dialog.CloseTrigger asChild>
              <Button
                position="absolute"
                top="18px"
                right="18px"
                bg="none"
                border="none"
                color={tokens.colors.text.muted}
                fontSize="16px"
                cursor="pointer"
                p={1}
                borderRadius="6px"
                minW="auto"
                _hover={{
                  bg: 'rgba(254, 16, 99, 0.1)',
                  color: tokens.colors.accent.primary,
                }}
              >
                &times;
              </Button>
            </Dialog.CloseTrigger>

            <Dialog.Body px={7} py={6}>
              <VStack gap={4} align="stretch">
                <Box>
                  <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.secondary} mb={2}>
                    Repository URL
                  </Text>
                  <Input placeholder="https://github.com/user/repo.git" {...inputStyles} />
                </Box>

                <Box>
                  <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.secondary} mb={2}>
                    Local Path
                  </Text>
                  <Input placeholder="~/Projects/repo" {...inputStyles} />
                </Box>

                <Box>
                  <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.secondary} mb={2}>
                    Branch (optional)
                  </Text>
                  <Input placeholder="main" {...inputStyles} />
                </Box>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer px={7} pb={7} pt={0}>
              <Button
                variant="ghost"
                mr={3}
                onClick={() => dialog.setOpen(false)}
                color={tokens.colors.text.secondary}
                fontSize="13px"
                borderRadius="10px"
                _hover={{
                  bg: 'rgba(255, 255, 255, 0.05)',
                  color: tokens.colors.text.primary,
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCloneProject}
                background={tokens.gradient.accentPrimary}
                color="white"
                fontSize="13px"
                fontWeight="600"
                borderRadius="10px"
                px={6}
                _hover={{
                  transform: 'translateY(-1px)',
                  boxShadow: '0 8px 24px rgba(254, 16, 99, 0.3)',
                }}
                transition="all 0.2s ease"
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
