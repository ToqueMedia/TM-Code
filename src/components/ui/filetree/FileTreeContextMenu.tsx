import React from 'react';
import { HStack, Menu, Portal } from '@chakra-ui/react';
import {
  FiFolderPlus, FiFilePlus, FiTrash2, FiEdit2, FiCopy,
  FiExternalLink, FiTerminal, FiSearch, FiScissors, FiClipboard, FiLink
} from 'react-icons/fi';
import { tokens } from '@/theme/tokens';
import type { FileTreeNode } from '@/types/fileTree'
import { t } from '@/i18n';

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
  onCopyRelativePath?: () => void;
  onOpenToSide?: () => void;
  onOpenInTerminal?: () => void;
  onFindInFolder?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
  hasCutOrCopied?: boolean;
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
  onCopyRelativePath,
  onOpenToSide,
  onOpenInTerminal,
  onFindInFolder,
  onCut,
  onPaste,
  hasCutOrCopied,
}) => {
  return (
    <Menu.Root open={open} onOpenChange={(details) => onOpenChange(details.open)}>
      {open && (
        <Portal>
          <Menu.Content
            bg={tokens.colors.menu.bg}
            borderColor={tokens.colors.menu.border}
            color={tokens.colors.text.primary}
            position="fixed"
            left={`${position.x}px`}
            top={`${position.y}px`}
            transform="none"
            zIndex={2000}
            minW="220px"
          >
            {/* File-specific: Open to the Side */}
            {node?.type === 'file' && onOpenToSide && (
              <>
                <Menu.Item value="open-side" onClick={(e) => { e.stopPropagation(); onOpenToSide(); }} _hover={{ bg: hoverAccent }}>
                  <HStack gap={2}>
                    <FiExternalLink size={14} />
                    <span>{t("filetree.openToSide")}</span>
                  </HStack>
                </Menu.Item>
                <Menu.Separator borderColor={tokens.colors.menu.separator} />
              </>
            )}

            {/* Directory: New File, New Folder */}
            {node?.type === 'directory' && (
              <>
                <Menu.Item value="new-file" onClick={(e) => { e.stopPropagation(); onNewFile(); }} _hover={{ bg: hoverAccent }}>
                  <HStack gap={2}>
                    <FiFilePlus size={14} />
                    <span>{t("filetree.newFile")}</span>
                  </HStack>
                </Menu.Item>
                <Menu.Item value="new-directory" onClick={(e) => { e.stopPropagation(); onNewFolder(); }} _hover={{ bg: hoverAccent }}>
                  <HStack gap={2}>
                    <FiFolderPlus size={14} />
                    <span>{t("filetree.newFolder")}</span>
                  </HStack>
                </Menu.Item>
                <Menu.Separator borderColor={tokens.colors.menu.separator} />
              </>
            )}

            {/* Cut / Copy / Paste */}
            {onCut && (
              <Menu.Item value="cut" onClick={(e) => { e.stopPropagation(); onCut(); }} _hover={{ bg: hoverAccent }}>
                <HStack gap={2}>
                  <FiScissors size={14} />
                  <span>{t("filetree.cut")}</span>
                </HStack>
              </Menu.Item>
            )}
            <Menu.Item value="copy" onClick={(e) => { e.stopPropagation(); onCopy(); }} _hover={{ bg: hoverAccent }}>
              <HStack gap={2}>
                <FiCopy size={14} />
                <span>{t("filetree.copy")}</span>
              </HStack>
            </Menu.Item>
            {onPaste && (
              <Menu.Item
                value="paste"
                onClick={(e) => { e.stopPropagation(); onPaste(); }}
                _hover={{ bg: hoverAccent }}
                disabled={!hasCutOrCopied}
                opacity={hasCutOrCopied ? 1 : 0.4}
              >
                <HStack gap={2}>
                  <FiClipboard size={14} />
                  <span>{t("filetree.paste")}</span>
                </HStack>
              </Menu.Item>
            )}

            <Menu.Separator borderColor={tokens.colors.menu.separator} />

            <Menu.Item value="rename" onClick={(e) => { e.stopPropagation(); onRename(); }} _hover={{ bg: hoverAccent }}>
              <HStack gap={2}>
                <FiEdit2 size={14} />
                <span>{t("filetree.rename")}</span>
              </HStack>
            </Menu.Item>
            <Menu.Item value="delete" onClick={(e) => { e.stopPropagation(); onDelete(); }} _hover={{ bg: hoverDanger }}>
              <HStack gap={2}>
                <FiTrash2 size={14} />
                <span>{t("filetree.delete")}</span>
              </HStack>
            </Menu.Item>

            <Menu.Separator borderColor={tokens.colors.menu.separator} />

            {/* Directory-specific: Open in Terminal, Find in Folder */}
            {node?.type === 'directory' && onOpenInTerminal && (
              <Menu.Item value="open-terminal" onClick={(e) => { e.stopPropagation(); onOpenInTerminal(); }} _hover={{ bg: hoverAccent }}>
                <HStack gap={2}>
                  <FiTerminal size={14} />
                  <span>{t("filetree.openInTerminal")}</span>
                </HStack>
              </Menu.Item>
            )}
            {node?.type === 'directory' && onFindInFolder && (
              <Menu.Item value="find-in-folder" onClick={(e) => { e.stopPropagation(); onFindInFolder(); }} _hover={{ bg: hoverAccent }}>
                <HStack gap={2}>
                  <FiSearch size={14} />
                  <span>{t("filetree.findInFolder")}</span>
                </HStack>
              </Menu.Item>
            )}
            {node?.type === 'directory' && (onOpenInTerminal || onFindInFolder) && (
              <Menu.Separator borderColor={tokens.colors.menu.separator} />
            )}

            <Menu.Item value="reveal" onClick={(e) => { e.stopPropagation(); onReveal(); }} _hover={{ bg: hoverAccent }}>
              <HStack gap={2}>
                <FiExternalLink size={14} />
                <span>{t("filetree.revealInFinder")}</span>
              </HStack>
            </Menu.Item>
            <Menu.Item value="copy-path" onClick={(e) => { e.stopPropagation(); onCopyPath(); }} _hover={{ bg: hoverAccent }}>
              <HStack gap={2}>
                <FiLink size={14} />
                <span>{t("filetree.copyPath")}</span>
              </HStack>
            </Menu.Item>
            {onCopyRelativePath && (
              <Menu.Item value="copy-rel-path" onClick={(e) => { e.stopPropagation(); onCopyRelativePath(); }} _hover={{ bg: hoverAccent }}>
                <HStack gap={2}>
                  <FiLink size={14} />
                  <span>{t("filetree.copyRelativePath")}</span>
                </HStack>
              </Menu.Item>
            )}
          </Menu.Content>
        </Portal>
      )}
    </Menu.Root>
  );
};

export default FileTreeContextMenu;
