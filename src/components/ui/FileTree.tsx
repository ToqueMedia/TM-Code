import React, { useState, useRef, useEffect } from 'react';
import { Box, Alert } from '@chakra-ui/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n';
import { useFileTreeRepository } from '@/stores/fileTreeStore';
import type { FileTreeNode } from '@/types/fileTree';
import FileWatcherService from '@/services/fileWatcherService';
import { logger } from '@/utils/logger';

import { MemoTreeNode } from './filetree/FileTreeNode';
import FileTreeContextMenu from './filetree/FileTreeContextMenu';
import { RenameDialog, CopyDialog } from './filetree/FileTreeDialogs';
import FileTreePlaceholder from './filetree/FileTreePlaceholder';
import { useFileTreeActions } from './filetree/useFileTreeActions';
import type { FileTreeProps, AlertState, FlatItem } from './filetree/types';

const FileTree: React.FC<FileTreeProps> = ({ rootPath, onFileSelect, onRefresh }) => {
  const root = useFileTreeRepository((s) => s.root);
  const loading = useFileTreeRepository((s) => s.loading);
  const error = useFileTreeRepository((s) => s.error);
  const loadFileTree = useFileTreeRepository((s) => s.loadFileTree);
  const refresh = useFileTreeRepository((s) => s.refresh);
  const expandedPaths = useFileTreeRepository((s) => s.expandedPaths);

  const fileWatcherRef = useRef(FileWatcherService.getInstance());
  const [alert, setAlert] = useState<AlertState>({ show: false, title: '', description: '', status: 'success' });
  const actions = useFileTreeActions(setAlert, onFileSelect);

  useEffect(() => {
    if (alert.show) {
      const timer = setTimeout(() => setAlert({ show: false, title: '', description: '', status: 'success' }), 3000);
      return () => clearTimeout(timer);
    }
  }, [alert]);

  useEffect(() => {
    if (rootPath) {
      loadFileTree(rootPath);
      (async () => {
        try { await fileWatcherRef.current.watchDirectory(rootPath); }
        catch (err) { logger.error('file', 'Failed to set up file watching:', err); }
      })();
    }
    return () => { fileWatcherRef.current.unwatchAll(); };
  }, [rootPath, loadFileTree]);

  const handleRefresh = async () => {
    try {
      await refresh();
      if (onRefresh) onRefresh();
      setAlert({ show: true, title: 'Refreshed', description: 'File tree updated', status: 'success' });
    } catch {
      setAlert({ show: true, title: 'Error', description: 'Failed to refresh file tree', status: 'error' });
    }
  };

  function flattenVisible(node: FileTreeNode | null, level: number, out: FlatItem[]): void {
    if (!node) return;
    out.push({ node, level });
    if (node.type === 'directory' && expandedPaths.has(node.path) && node.children) {
      for (const child of node.children) flattenVisible(child, level + 0.5, out);
    }
  }

  const flatNodes = React.useMemo<FlatItem[]>(() => {
    const out: FlatItem[] = [];
    if (root) flattenVisible(root, 0, out);
    return out;
  }, [root, expandedPaths]);

  const parentRef = React.useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 22,
    overscan: 8,
  });

  if (loading) return <FileTreePlaceholder variant="loading" onRefresh={handleRefresh} />;
  if (error) return <FileTreePlaceholder variant="error" error={error} onRefresh={handleRefresh} />;
  if (!root) return <FileTreePlaceholder variant="empty" onRefresh={handleRefresh} />;

  return (
    <Box className="vscode-sidebar" bg={tokens.colors.bg.sidebar} color={tokens.colors.text.primary} height="100%" overflow="hidden">
      {alert.show && (
        <Alert.Root
          status={alert.status} mb={2} size="sm"
          bg={alert.status === 'success' ? tokens.colors.accent.greenSubtle : tokens.colors.accent.redSubtle}
          borderColor={alert.status === 'success' ? tokens.colors.accent.greenMuted : tokens.colors.accent.redMuted}
          mx={2} mt={2}
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{alert.title}</Alert.Title>
            <Alert.Description>{alert.description}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      <Box ref={parentRef} role="tree" aria-label={t("explorer.fileExplorer")} flex={1} overflowY="auto" overflowX="hidden" pt={1} minW="100%" position="relative">
        <Box position="relative" height={`${virtualizer.getTotalSize()}px`}>
          {virtualizer.getVirtualItems().map((item) => {
            const flat = flatNodes[item.index];
            return (
              <Box key={flat.node.path} position="absolute" top={0} left={0} width="100%" transform={`translateY(${item.start}px)`}>
                <MemoTreeNode node={flat.node} level={flat.level} onFileSelect={onFileSelect} setAlert={setAlert} onOpenContextMenu={actions.openContextMenu} />
              </Box>
            );
          })}
        </Box>
      </Box>

      <FileTreeContextMenu
        open={actions.menuOpen} onOpenChange={actions.setMenuOpen} position={actions.menuPos} node={actions.menuNode}
        onNewFile={actions.handleNewFile} onNewFolder={actions.handleNewFolder} onCopy={actions.beginCopy}
        onRename={actions.beginRename} onDelete={actions.handleDeleteFromMenu} onReveal={actions.handleReveal} onCopyPath={actions.handleCopyPath}
        onCopyRelativePath={actions.handleCopyRelativePath}
        onOpenToSide={actions.handleOpenToSide}
        onOpenInTerminal={actions.handleOpenInTerminal}
        onFindInFolder={actions.handleFindInFolder}
      />

      <RenameDialog
        open={actions.renameOpen} onClose={() => actions.setRenameOpen(false)} node={actions.menuNode}
        value={actions.renameName} onChange={actions.setRenameName} onConfirm={actions.confirmRename} inputRef={actions.renameInputRef}
      />

      <CopyDialog
        open={actions.copyOpen} onClose={() => actions.setCopyOpen(false)} node={actions.menuNode}
        value={actions.copyName} onChange={actions.setCopyName} onConfirm={actions.confirmCopy} inputRef={actions.copyInputRef}
      />
    </Box>
  );
};

export default FileTree;
