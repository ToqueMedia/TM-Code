import React from 'react'
import {
  Box,
  Button,
  Heading,
  Text,
  Dialog,
  Portal,
  Input,
  NativeSelect,
  VStack,
} from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

const templates = [
  { label: 'React TypeScript', value: 'react-ts' },
  { label: 'Node.js Express', value: 'node-express' },
  { label: 'Python FastAPI', value: 'python-fastapi' },
  { label: 'Vue.js', value: 'vue' },
  { label: 'Rust', value: 'rust' },
  { label: 'Empty Project', value: 'empty' },
]

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

interface NewProjectDialogProps {
  dialog: ReturnType<typeof import('@chakra-ui/react').useDialog>
}

const NewProjectDialog: React.FC<NewProjectDialogProps> = ({ dialog }) => {
  const handleCreateProject = () => {
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
              <Heading fontSize="24px" fontWeight="600">Create New Project</Heading>
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
                  <Text fontSize="14px" color={tokens.colors.text.primary} mb={2}>Project Name</Text>
                  <Input placeholder="my-awesome-project" {...inputStyles} />
                </Box>

                <Box>
                  <Text fontSize="14px" color={tokens.colors.text.primary} mb={2}>Template</Text>
                  <NativeSelect.Root size="sm">
                    <NativeSelect.Field placeholder="Select template">
                      {templates.map((template) => (
                        <option key={template.value} value={template.value}>
                          {template.label}
                        </option>
                      ))}
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                </Box>

                <Box>
                  <Text fontSize="14px" color={tokens.colors.text.primary} mb={2}>Location</Text>
                  <Input placeholder="~/Projects" {...inputStyles} />
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
                onClick={handleCreateProject}
                background={tokens.gradient.accentPrimary}
                color={tokens.colors.text.inverse}
                _hover={{
                  transform: 'translateY(-2px)',
                  boxShadow: tokens.shadow.dialogButton,
                }}
              >
                Create Project
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.RootProvider>
  )
}

export default NewProjectDialog
