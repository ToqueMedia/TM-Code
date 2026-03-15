import React from 'react';
import { HStack, Menu, Portal } from '@chakra-ui/react';
import { FiFolderPlus, FiFilePlus, FiTrash2, FiEdit2, FiCopy } from 'react-icons/fi';
import { tokens } from '@/theme/tokens';
import type { FileTreeNode } from '@/types/fileTree';

interface FileTreeContextMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  position: { x: number; y: number };
  node: FileTreeNode | null;
  onNewFile: () => void;
  onNewFolder: () => void;
  onCopy: () => void;
  onRename: () => void;
  onDelete: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
}

const hoverAccent = tokens.colors.accent.primarySubtle;
const hoverDanger = tokens.colors.accent.redSubtle;

const FileTreeContextMenu: React.FC<FileTreeContextMenuProps> = ({
  open,
  onOpenChange,
  position,
  node,
  onNewFile,
  onNewFolder,
  onCopy,
  onRename,
  onDelete,
  onReveal,
  onCopyPath,
}) => {
  return (
    <Menu.Root open={open} onOpenChange={(details) => onOpenChange(details.open)}>
      {open && (
        <Portal>
          <Menu.Content
            bg={tokens.colors.menu.bg}
            borderColor={tokens.colors.border.default}
            color={tokens.colors.text.primary}
            position="fixed"
            left={`${position.x}px`}
            top={`${position.y}px`}
            transform="none"
            zIndex={2000}
          >
            {node?.type === 'directory' && (
              <>
                <Menu.Item value="new-file" onClick={(e) => { e.stopPropagation(); onNewFile(); }} _hover={{ bg: hoverAccent }}>
                  <HStack gap={2}>
                    <FiFilePlus size={14} />
                    <span>New File</span>
                  </HStack>
                </Menu.Item>
                <Menu.Item value="new-directory" onClick={(e) => { e.stopPropagation(); onNewFolder(); }} _hover={{ bg: hoverAccent }}>
                  <HStack gap={2}>
                    <FiFolderPlus size={14} />
                    <span>New Folder</span>
                  </HStack>
                </Menu.Item>
                <Menu.Separator borderColor={tokens.colors.border.default} />
              </>
            )}
            <Menu.Item value="copy" onClick={(e) => { e.stopPropagation(); onCopy(); }} _hover={{ bg: hoverAccent }}>
              <HStack gap={2}>
                <FiCopy size={14} />
                <span>Copy</span>
              </HStack>
            </Menu.Item>
            <Menu.Item value="rename" onClick={(e) => { e.stopPropagation(); onRename(); }} _hover={{ bg: hoverAccent }}>
              <HStack gap={2}>
                <FiEdit2 size={14} />
                <span>Rename</span>
              </HStack>
            </Menu.Item>
            <Menu.Item value="delete" onClick={(e) => { e.stopPropagation(); onDelete(); }} _hover={{ bg: hoverDanger }}>
              <HStack gap={2}>
                <FiTrash2 size={14} />
                <span>Delete</span>
              </HStack>
            </Menu.Item>
            <Menu.Separator borderColor={tokens.colors.border.default} />
            <Menu.Item value="reveal" onClick={(e) => { e.stopPropagation(); onReveal(); }} _hover={{ bg: hoverAccent }}>
              <HStack gap={2}>
                <FiFolderPlus size={14} />
                <span>Reveal in Finder</span>
              </HStack>
            </Menu.Item>
            <Menu.Item value="copy-path" onClick={(e) => { e.stopPropagation(); onCopyPath(); }} _hover={{ bg: hoverAccent }}>
              <HStack gap={2}>
                <FiCopy size={14} />
                <span>Copy Path</span>
              </HStack>
            </Menu.Item>
          </Menu.Content>
        </Portal>
      )}
    </Menu.Root>
  );
};

export default FileTreeContextMenu;
