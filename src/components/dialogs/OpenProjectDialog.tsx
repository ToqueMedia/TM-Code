import { useState } from 'react';
import {
  Button,
  Dialog,
  Field,
  Input,
  Portal,
} from '@chakra-ui/react';
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n';
import { useProjectStore } from '../../stores/projectStore';
import { open } from '@tauri-apps/plugin-dialog';
import { ProjectValidator } from '../../utils/projectValidator';
import { logger } from '../../utils/logger';

interface OpenProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function OpenProjectDialog({ isOpen, onClose }: OpenProjectDialogProps) {
  const [projectPath, setProjectPath] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const { openProject } = useProjectStore();

  const handleSubmit = async () => {
    if (!projectPath.trim()) return;
    
    setIsLoading(true);
    setError('');
    
    try {
      // Validate project before opening
      const validation = await ProjectValidator.validateProjectPath(projectPath);
      if (!validation.valid) {
        setError(validation.error || 'Invalid project directory. Please select a valid project folder.');
        setIsLoading(false);
        return;
      }
      
      await openProject(projectPath);
      onClose();
      setProjectPath('');
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open project:', error);
      if (error instanceof Error) {
        setError(error.message || 'Failed to open project. Please try again.');
      } else {
        setError('Failed to open project. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select project directory'
      });
      if (selected) {
        setProjectPath(selected as string);
      }
    } catch (error: unknown) {
      logger.error('ui', 'Failed to open directory dialog:', error);
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(e) => !e.open && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            bg="gray.800"
            color="white"
            border="1px solid"
            borderColor="gray.600"
          >
            <Dialog.Header
              bg="gray.700"
              borderBottom="1px solid"
              borderColor="gray.600"
              color="white"
            >
              <Dialog.Title>{t("misc.openProject")}</Dialog.Title>
            </Dialog.Header>
            
            <Dialog.Body 
              pb={6}
              bg="gray.800"
            >
              <Field.Root>
                <Field.Label 
                  color="white"
                  fontWeight="600"
                  fontSize="14px"
                >
                  Project Path
                </Field.Label>
                <Input
                  value={projectPath}
                  onChange={(e) => setProjectPath(e.target.value)}
                  placeholder="~/Projects/my-project"
                  mb={2}
                  bg="gray.700"
                  color="white"
                  border="1px solid"
                  borderColor="gray.600"
                  _focus={{
                    borderColor: "blue.500",
                    boxShadow: "none"
                  }}
                />
                <Button 
                  size="sm" 
                  variant="outline"
                  onClick={handleBrowse}
                  color="white"
                  borderColor="gray.600"
                  _hover={{
                    bg: tokens.colors.accent.primarySubtle,
                    borderColor: tokens.colors.accent.blue
                  }}
                >
                  Browse
                </Button>
              </Field.Root>
              
              {error && (
                <Field.Root>
                  <Field.ErrorText 
                    color="red.400" 
                    mt={2}
                    fontSize="13px"
                  >
                    {error}
                  </Field.ErrorText>
                </Field.Root>
              )}
            </Dialog.Body>

            <Dialog.Footer
              bg="gray.700"
              borderTop="1px solid"
              borderColor="gray.600"
            >
              <Button 
                variant="outline"
                onClick={onClose}
                color="white"
                borderColor="gray.600"
                _hover={{
                  bg: tokens.colors.bg.whiteOverlay,
                  borderColor: tokens.colors.border.subtle
                }}
              >
                Cancel
              </Button>
              <Button
                colorPalette="blue"
                onClick={handleSubmit}
                loading={isLoading}
                loadingText="Opening..."
                disabled={!projectPath.trim()}
                bg="blue.500"
                color="white"
                _hover={{
                  bg: "blue.600"
                }}
                _disabled={{
                  bg: "blue.500",
                  opacity: 0.5,
                  cursor: "not-allowed"
                }}
              >
                Open Project
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}