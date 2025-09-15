import { useState } from 'react';
import {
  Button,
  Dialog,
  Field,
  Input,
  Portal,
} from '@chakra-ui/react';
import { useProjectStore } from '../../stores/projectStore';
import { open } from '@tauri-apps/plugin-dialog';
import { ProjectValidator } from '../../utils/projectValidator';

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
        return;
      }
      
      await openProject(projectPath);
      onClose();
      setProjectPath('');
    } catch (error) {
      console.error('Failed to open project:', error);
      setError('Failed to open project. Please try again.');
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
    } catch (error) {
      console.error('Failed to open directory dialog:', error);
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(e) => !e.open && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Open Project</Dialog.Title>
            </Dialog.Header>
            
            <Dialog.Body pb={6}>
              <Field.Root>
                <Field.Label>Project Path</Field.Label>
                <Input
                  value={projectPath}
                  onChange={(e) => setProjectPath(e.target.value)}
                  placeholder="~/Projects/my-project"
                  mb={2}
                />
                <Button size="sm" variant="outline" onClick={handleBrowse}>
                  Browse
                </Button>
              </Field.Root>
              
              {error && (
                <Field.ErrorText color="red.400" mt={2}>
                  {error}
                </Field.ErrorText>
              )}
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                colorPalette="blue"
                onClick={handleSubmit}
                loading={isLoading}
                loadingText="Opening..."
                disabled={!projectPath.trim()}
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