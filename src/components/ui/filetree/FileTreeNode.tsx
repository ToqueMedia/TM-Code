import React, { useState, useRef, useEffect } from 'react';
import { Box, HStack, Text, Icon, Input } from '@chakra-ui/react';
import { FiChevronRight, FiChevronDown } from 'react-icons/fi';
import { tokens } from '@/theme/tokens';
import { useFileTreeRepository } from '@/stores/fileTreeStore';
import { useEditorRepository } from '@/stores/editorStore';
import type { TreeNodeProps } from './types';
import FileTreeIcon from './FileTreeIcon';

const TreeNode: React.FC<TreeNodeProps> = ({
  node,
  level,
  onFileSelect,
  setAlert,
  onOpenContextMenu,
}) => {
  const toggleNode = useFileTreeRepository((s) => s.toggleNode);
  const selectNode = useFileTreeRepository((s) => s.selectNode);
  const renameNode = useFileTreeRepository((s) => s.renameNode);
  const isExpanded = useFileTreeRepository(function (s) { return s.expandedPaths.has(node.path) });
  const isSelected = useFileTreeRepository(function (s) { return s.selectedPath === node.path });

  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(node.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.type === 'directory') {
      toggleNode(node.path);
    }
  };

  const handleSelect = () => {
    selectNode(node.path);
    if (node.type === 'directory') {
      toggleNode(node.path);
      return;
    }
    if (node.type === 'file' && onFileSelect) {
      onFileSelect(node.path);
    }
  };

  const confirmRename = async () => {
    if (newName && newName !== node.name) {
      const success = await renameNode(node.path, newName);
      if (success) {
        try {
          const parentDir = node.path.substring(0, node.path.lastIndexOf('/'));
          const newPath = parentDir ? `${parentDir}/${newName}` : newName;
          useEditorRepository.getState().renameOpenFile?.(node.path, newPath);
          const lsp = (await import('@/services/typescriptLspService')).default.getInstance();
          await lsp.renameFileModel(node.path, newPath);
        } catch { /* ignore */ }
      } else {
        setAlert({ show: true, title: 'Error', description: `Failed to rename ${node.name}`, status: 'error' });
      }
    }
    setIsRenaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent, callback: () => void) => {
    if (e.key === 'Enter') {
      callback();
    } else if (e.key === 'Escape') {
      setIsRenaming(false);
    }
  };

  function handleRowContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof window !== 'undefined') {
      const pos = { x: e.clientX, y: e.clientY };
      onOpenContextMenu?.(node, pos);
    }
  }

  function handleRowKeyDown(e: React.KeyboardEvent) {
    if (e.shiftKey && e.key === 'F10') {
      e.preventDefault();
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const pos = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      onOpenContextMenu?.(node, pos);
    }
  }

  const selectedBg = tokens.colors.bg.activeItem;
  const hoverBg = tokens.colors.bg.whiteHover;

  return (
    <Box role="treeitem" aria-expanded={node.type === 'directory' ? isExpanded : undefined} aria-label={node.name}>
      <HStack
        py={0}
        pl={level * 8 + 4}
        pr={2}
        bg={isSelected ? selectedBg : 'transparent'}
        color={isSelected ? tokens.colors.text.inverse : tokens.colors.text.primary}
        _hover={{ bg: isSelected ? selectedBg : hoverBg }}
        cursor="pointer"
        onClick={handleSelect}
        onContextMenu={handleRowContextMenu}
        onKeyDown={handleRowKeyDown}
        tabIndex={0}
        borderRadius={0}
        position="relative"
        gap={0}
        minHeight="22px"
        alignItems="center"
        minW="max-content"
        w="100%"
      >
        {node.type === 'directory' ? (
          <Icon
            as={isExpanded ? FiChevronDown : FiChevronRight}
            onClick={handleToggle}
            cursor="pointer"
            fontSize="10px"
            color={isSelected ? tokens.colors.text.inverse : tokens.colors.text.primary}
            width="16px"
            height="16px"
            display="flex"
            alignItems="center"
            justifyContent="center"
            mr={1}
          />
        ) : (
          <Box width="17px" />
        )}

        <FileTreeIcon
          type={node.type}
          extension={node.extension}
          fileName={node.name}
          fullPath={node.path}
          isSelected={isSelected}
          isExpanded={isExpanded}
        />

        {isRenaming ? (
          <Input
            ref={renameInputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => handleKeyDown(e, confirmRename)}
            onBlur={() => setIsRenaming(false)}
            size="xs"
            variant="flushed"
            color={isSelected ? tokens.colors.text.inverse : tokens.colors.text.primary}
            bg={isSelected ? tokens.colors.bg.selection : 'transparent'}
            flex={1}
            px={1}
            py={0}
            height="20px"
            fontSize="sm"
          />
        ) : (
          <Text
            fontSize={tokens.fontSize.md}
            flex={1}
            lineClamp={1}
            color={isSelected ? tokens.colors.text.inverse : tokens.colors.text.primary}
            fontWeight="400"
            fontFamily={tokens.fontFamily.ui}
            letterSpacing="0.02em"
          >
            {node.name}
          </Text>
        )}
      </HStack>
    </Box>
  );
};

function areEqualTreeNodeProps(prev: TreeNodeProps, next: TreeNodeProps): boolean {
  if (prev.level !== next.level) return false;
  if (prev.node.path !== next.node.path) return false;
  if (prev.onFileSelect !== next.onFileSelect) return false;
  if (prev.setAlert !== next.setAlert) return false;
  return true;
}

export const MemoTreeNode = React.memo<TreeNodeProps>(TreeNode, areEqualTreeNodeProps);

export default TreeNode;
