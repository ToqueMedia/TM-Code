import { useState } from 'react';
import {
  Button,
  Dialog,
  Field,
  Input,
  Portal,
  Select,
} from '@chakra-ui/react';
import { createListCollection } from '@chakra-ui/react';
import { useProjectStore } from '../../stores/projectStore';
import { ProjectTemplate } from '../../types/project';
import { open } from '@tauri-apps/plugin-dialog';

interface NewProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NewProjectDialog({ isOpen, onClose }: NewProjectDialogProps) {
  const [projectName, setProjectName] = useState('');
  const [template, setTemplate] = useState(ProjectTemplate.Blank);
  const [location, setLocation] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { createProject } = useProjectStore();

  const templateCollection = createListCollection({
    items: [
      { label: 'Blank Project', value: ProjectTemplate.Blank },
      { label: 'React Project', value: ProjectTemplate.React },
      { label: 'Node.js Project', value: ProjectTemplate.Node },
      { label: 'TypeScript Project', value: ProjectTemplate.TypeScript },
    ],
  });

  const handleSubmit = async () => {
    if (!projectName.trim()) return;
    
    setIsLoading(true);
    try {
      // In a real implementation, we would create the project directory
      // For now, we'll just use the location as the path
      const projectPath = `${location || '~/Projects'}/${projectName}`;
      await createProject(projectPath, template);
      onClose();
      setProjectName('');
      setTemplate(ProjectTemplate.Blank);
      setLocation('');
    } catch (error) {
      console.error('Failed to create project:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select project location'
      });
      if (selected) {
        setLocation(selected as string);
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
              <Dialog.Title>Create New Project</Dialog.Title>
            </Dialog.Header>
            
            <Dialog.Body pb={6}>
              <Field.Root>
                <Field.Label>Project Name</Field.Label>
                <Input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="my-awesome-project"
                />
              </Field.Root>

              <Field.Root mt={4}>
                <Field.Label>Template</Field.Label>
                <Select.Root
                  collection={templateCollection}
                  value={[template]}
                  onValueChange={(e) => setTemplate(e.value[0] as ProjectTemplate)}
                >
                  <Select.Control>
                    <Select.Trigger>
                      <Select.ValueText />
                    </Select.Trigger>
                    <Select.Indicator />
                  </Select.Control>
                  <Portal>
                    <Select.Positioner>
                      <Select.Content>
                        {templateCollection.items.map((item) => (
                          <Select.Item key={item.value} item={item}>
                            {item.label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Portal>
                </Select.Root>
              </Field.Root>

              <Field.Root mt={4}>
                <Field.Label>Location</Field.Label>
                <Input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="~/Projects"
                  mb={2}
                />
                <Button size="sm" variant="outline" onClick={handleBrowse}>
                  Browse
                </Button>
              </Field.Root>
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                colorPalette="blue"
                onClick={handleSubmit}
                loading={isLoading}
                loadingText="Creating..."
                disabled={!projectName.trim()}
              >
                Create Project
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}