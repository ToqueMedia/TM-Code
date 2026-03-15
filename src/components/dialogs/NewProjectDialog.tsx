import {
  Dialog,
  Portal,
} from '@chakra-ui/react'
import { useNewProjectDialog } from './useNewProjectDialog'
import { NewProjectForm } from './NewProjectForm'
import NewProjectActions from './NewProjectActions'

interface NewProjectDialogProps {
  isOpen: boolean
  onClose: () => void
}

export function NewProjectDialog({ isOpen, onClose }: NewProjectDialogProps) {
  const {
    projectName,
    setProjectName,
    template,
    setTemplate,
    location,
    setLocation,
    isLoading,
    error,
    fileInputRef,
    handleSubmit,
    handleBrowse,
    handleFileInputChange,
  } = useNewProjectDialog(onClose)

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

            <Dialog.Body pb={6} bg="bg.editor">
              <NewProjectForm
                projectName={projectName}
                onProjectNameChange={setProjectName}
                template={template}
                onTemplateChange={setTemplate}
                location={location}
                onLocationChange={setLocation}
                onBrowse={handleBrowse}
                error={error}
                fileInputRef={fileInputRef}
                onFileInputChange={handleFileInputChange}
              />
            </Dialog.Body>

            <NewProjectActions
              onClose={onClose}
              onSubmit={handleSubmit}
              isLoading={isLoading}
              isDisabled={!projectName.trim() || !location.trim()}
            />
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
