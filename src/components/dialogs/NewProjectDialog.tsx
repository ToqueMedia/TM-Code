import { useState, useRef } from 'react';
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
import { ProjectValidator } from '../../utils/projectValidator';
import { logger } from '../../utils/logger';

interface NewProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NewProjectDialog({ isOpen, onClose }: NewProjectDialogProps) {
  const [projectName, setProjectName] = useState('');
  const [template, setTemplate] = useState(ProjectTemplate.Blank);
  const [location, setLocation] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { createProject } = useProjectStore();

  const templateCollection = createListCollection({
    items: [
      { label: 'Blank Project', value: ProjectTemplate.Blank },
      { label: 'React Project', value: ProjectTemplate.React },
      { label: 'Node.js Project', value: ProjectTemplate.Node },
      { label: 'TypeScript Project', value: ProjectTemplate.TypeScript },
      { label: 'Vue.js Project', value: ProjectTemplate.Vue },
      { label: 'Python Project', value: ProjectTemplate.Python },
      { label: 'Rust Project', value: ProjectTemplate.Rust },
    ],
  });

  const handleSubmit = async () => {
    if (!projectName.trim()) {
      setError('Project name is required');
      return;
    }
    
    if (!location.trim()) {
      setError('Project location is required');
      return;
    }
    
    setIsLoading(true);
    setError('');
    
    try {
      // Validate project name
      const nameValidation = await ProjectValidator.validateProjectName(projectName);
      if (!nameValidation.valid) {
        setError(nameValidation.error || 'Invalid project name');
        setIsLoading(false);
        return;
      }
      
      // Validate project location
      const locationValidation = await ProjectValidator.validateProjectLocation(location);
      if (!locationValidation.valid) {
        setError(locationValidation.error || 'Invalid project location');
        setIsLoading(false);
        return;
      }
      
      // Create the project path
      const projectPath = `${location}/${projectName}`;
      
      await createProject(projectPath, template);
      onClose();
      setProjectName('');
      setTemplate(ProjectTemplate.Blank);
      setLocation('');
      setError('');
    } catch (error: unknown) {
      logger.error('ui', 'Failed to create project:', error);
      setError((error as Error).message || 'Failed to create project. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBrowse = async () => {
    try {
      // Check if we're in a Tauri context
      // @ts-ignore
      if (typeof window !== 'undefined' && window.__TAURI__) {
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Select project location'
        });
        if (selected) {
          setLocation(selected as string);
        }
      } else {
        // Fallback for web development - trigger file input
        fileInputRef.current?.click();
      }
    } catch (error) {
      logger.error('ui', 'Failed to open directory dialog:', error);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // In web context, we can only get the file name, not the full path
      // For a real implementation, we would need to use the File System Access API
      setError('Full directory access is only available in the desktop app. Please enter the path manually.');
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(e) => !e.open && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            bg="bg.editor"
            color="text.primary"
            border="1px solid"
            borderColor="border.default"
          >
            <Dialog.Header
              bg="bg.glass"
              borderBottom="1px solid"
              borderColor="border.default"
              color="text.primary"
            >
              <Dialog.Title>Create New Project</Dialog.Title>
            </Dialog.Header>
            
            <Dialog.Body 
              pb={6}
              bg="bg.editor"
            >
              <Field.Root>
                <Field.Label 
                  color="text.primary"
                  fontWeight="600"
                  fontSize="14px"
                >
                  Project Name
                </Field.Label>
                <Input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="my-awesome-project"
                  bg="bg.glass"
                  color="text.primary"
                  border="1px solid"
                  borderColor="border.default"
                  _focus={{
                    borderColor: "blue.500",
                    boxShadow: "0 0 0 2px rgba(88, 166, 255, 0.3)"
                  }}
                />
              </Field.Root>

              <Field.Root mt={4}>
                <Field.Label 
                  color="text.primary"
                  fontWeight="600"
                  fontSize="14px"
                >
                  Template
                </Field.Label>
                <Select.Root
                  collection={templateCollection}
                  value={[template]}
                  onValueChange={(e) => setTemplate(e.value[0] as ProjectTemplate)}
                >
                  <Select.Control
                    bg="bg.glass"
                    border="1px solid"
                    borderColor="border.default"
                    _focus={{
                      borderColor: "blue.500",
                      boxShadow: "0 0 0 2px rgba(88, 166, 255, 0.3)"
                    }}
                  >
                    <Select.Trigger>
                      <Select.ValueText 
                        color="text.primary"
                      />
                    </Select.Trigger>
                    <Select.Indicator />
                  </Select.Control>
                  <Portal>
                    <Select.Positioner>
                      <Select.Content
                        bg="bg.editor"
                        color="text.primary"
                        border="1px solid"
                        borderColor="border.default"
                      >
                        {templateCollection.items.map((item) => (
                          <Select.Item 
                            key={item.value} 
                            item={item}
                            bg="bg.editor"
                            color="text.primary"
                            _hover={{
                              bg: "rgba(88, 166, 255, 0.1)"
                            }}
                            _selected={{
                              bg: "blue.500",
                              color: "white"
                            }}
                          >
                            {item.label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Portal>
                </Select.Root>
              </Field.Root>

              <Field.Root mt={4}>
                <Field.Label 
                  color="text.primary"
                  fontWeight="600"
                  fontSize="14px"
                >
                  Location
                </Field.Label>
                <Input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="~/Projects"
                  mb={2}
                  bg="bg.glass"
                  color="text.primary"
                  border="1px solid"
                  borderColor="border.default"
                  _focus={{
                    borderColor: "blue.500",
                    boxShadow: "0 0 0 2px rgba(88, 166, 255, 0.3)"
                  }}
                />
                <Button 
                  size="sm" 
                  variant="outline"
                  onClick={handleBrowse}
                  color="text.primary"
                  borderColor="border.default"
                  _hover={{
                    bg: "rgba(88, 166, 255, 0.1)",
                    borderColor: "blue.500"
                  }}
                >
                  Browse
                </Button>
              </Field.Root>
              
              {/* Hidden file input for web fallback */}
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: 'none' }}
                onChange={handleFileInputChange}
                // @ts-ignore
                directory=""
                webkitdirectory=""
              />
              
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
                  bg: "rgba(255, 255, 255, 0.1)",
                  borderColor: "text.secondary"
                }}
              >
                Cancel
              </Button>
              <Button
                colorPalette="blue"
                onClick={handleSubmit}
                loading={isLoading}
                loadingText="Creating..."
                disabled={!projectName.trim() || !location.trim()}
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
                Create Project
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}