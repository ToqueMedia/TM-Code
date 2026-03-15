import React from 'react';
import { Button, Input, Dialog } from '@chakra-ui/react';
import type { FileTreeNode } from '@/types/fileTree';

interface RenameDialogProps {
  open: boolean;
  onClose: () => void;
  node: FileTreeNode | null;
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

interface CopyDialogProps {
  open: boolean;
  onClose: () => void;
  node: FileTreeNode | null;
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export const RenameDialog: React.FC<RenameDialogProps> = ({
  open, onClose, node, value, onChange, onConfirm, inputRef,
}) => (
  <Dialog.Root open={open} onOpenChange={onClose}>
    <Dialog.Backdrop bg="blackAlpha.800" />
    <Dialog.Positioner>
      <Dialog.Content
        bg="bg.panel"
        borderColor="border"
        color="fg"
        shadow="xl"
        borderRadius="lg"
        maxW="400px"
      >
        <Dialog.Header pb={3}>
          <Dialog.Title fontSize="lg" fontWeight="600">
            Rename {node?.name}
          </Dialog.Title>
        </Dialog.Header>
        <Dialog.Body py={4}>
          <Input
            ref={inputRef}
            placeholder="Enter new name"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfirm();
              if (e.key === 'Escape') onClose();
            }}
            size="md"
            bg="bg"
            borderColor="border"
            color="fg"
            _focus={{
              borderColor: 'blue.emphasized',
              boxShadow: '0 0 0 1px var(--chakra-colors-blue-emphasized)',
            }}
          />
        </Dialog.Body>
        <Dialog.Footer pt={4}>
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            borderColor="border"
            color="fg.muted"
            _hover={{ bg: 'bg.muted', color: 'fg' }}
          >
            Cancel
          </Button>
          <Button
            colorPalette="blue"
            size="sm"
            onClick={onConfirm}
            ml={3}
            bg="blue.solid"
            color="blue.contrast"
            _hover={{ bg: 'blue.emphasized' }}
          >
            Rename
          </Button>
        </Dialog.Footer>
        <Dialog.CloseTrigger
          color="fg.muted"
          _hover={{ color: 'red.solid' }}
        />
      </Dialog.Content>
    </Dialog.Positioner>
  </Dialog.Root>
);

export const CopyDialog: React.FC<CopyDialogProps> = ({
  open, onClose, node, value, onChange, onConfirm, inputRef,
}) => (
  <Dialog.Root open={open} onOpenChange={() => onClose()}>
    <Dialog.Backdrop bg="blackAlpha.800" />
    <Dialog.Positioner>
      <Dialog.Content
        bg="bg.panel"
        borderColor="border"
        color="fg"
        shadow="xl"
        borderRadius="lg"
        maxW="400px"
      >
        <Dialog.Header pb={3}>
          <Dialog.Title fontSize="lg" fontWeight="600">
            Copy {node?.name}
          </Dialog.Title>
        </Dialog.Header>
        <Dialog.Body py={4}>
          <Input
            ref={inputRef}
            placeholder="Enter new name"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfirm();
              if (e.key === 'Escape') onClose();
            }}
            size="md"
            bg="bg"
            borderColor="border"
            color="fg"
            _focus={{
              borderColor: 'blue.emphasized',
              boxShadow: '0 0 0 1px var(--chakra-colors-blue-emphasized)',
            }}
          />
        </Dialog.Body>
        <Dialog.Footer pt={4}>
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            borderColor="border"
            color="fg.muted"
            _hover={{ bg: 'bg.muted', color: 'fg' }}
          >
            Cancel
          </Button>
          <Button
            colorPalette="blue"
            size="sm"
            onClick={onConfirm}
            ml={3}
            bg="blue.solid"
            color="blue.contrast"
            _hover={{ bg: 'blue.emphasized' }}
          >
            Copy
          </Button>
        </Dialog.Footer>
        <Dialog.CloseTrigger
          color="fg.muted"
          _hover={{ color: 'red.solid' }}
        />
      </Dialog.Content>
    </Dialog.Positioner>
  </Dialog.Root>
);
