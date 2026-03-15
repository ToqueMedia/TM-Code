import { useState, useRef } from 'react';
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { useFileTreeRepository } from '@/stores/fileTreeStore';
import type { FileTreeNode } from '@/types/fileTree';
import type { AlertState } from './types';

export function useFileTreeActions(
  setAlert: (alert: AlertState) => void,
  onFileSelect?: (path: string) => void,
) {
  const selectNode = useFileTreeRepository((s) => s.selectNode);
  const deleteNode = useFileTreeRepository((s) => s.deleteNode);
  const createFileOrDirectory = useFileTreeRepository((s) => s.createFileOrDirectory);
  const renameNode = useFileTreeRepository((s) => s.renameNode);
  const copyNode = useFileTreeRepository((s) => s.copyNode);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [menuNode, setMenuNode] = useState<FileTreeNode | null>(null);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [copyOpen, setCopyOpen] = useState(false);
  const [copyName, setCopyName] = useState('');
  const copyInputRef = useRef<HTMLInputElement>(null);

  function openContextMenu(node: FileTreeNode, pos: { x: number; y: number }): void {
    selectNode(node.path);
    setMenuNode(node);
    setMenuPos(pos);
    setMenuOpen(true);
  }

  function closeContextMenu(): void {
    setMenuOpen(false);
  }

  function beginRename(): void {
    if (!menuNode) return;
    setRenameName(menuNode.name);
    setRenameOpen(true);
    closeContextMenu();
  }

  async function confirmRename(): Promise<void> {
    if (!menuNode) { setRenameOpen(false); return; }
    if (!renameName || renameName === menuNode.name) { setRenameOpen(false); return; }
    const ok = await renameNode(menuNode.path, renameName);
    if (!ok) {
      setAlert({ show: true, title: 'Error', description: `Failed to rename ${menuNode.name}`, status: 'error' });
    }
    setRenameOpen(false);
  }

  function beginCopy(): void {
    if (!menuNode) return;
    const baseName = menuNode.name;
    const proposal = menuNode.type === 'directory'
      ? `${baseName}-copy`
      : baseName.includes('.')
        ? `${baseName.split('.').slice(0, -1).join('.')} copy.${baseName.split('.').pop()}`
        : `${baseName} copy`;
    setCopyName(proposal);
    setCopyOpen(true);
    closeContextMenu();
  }

  async function confirmCopy(): Promise<void> {
    if (!menuNode) { setCopyOpen(false); return; }
    if (!copyName) { setCopyOpen(false); return; }
    const parentDir = menuNode.path.substring(0, menuNode.path.lastIndexOf('/'));
    const destinationPath = `${parentDir}/${copyName}`;
    const ok = await copyNode(menuNode.path, destinationPath);
    if (!ok) {
      setAlert({ show: true, title: 'Error', description: `Failed to copy ${menuNode.name}`, status: 'error' });
    } else {
      setAlert({ show: true, title: 'Success', description: `Copied ${menuNode.name} to ${copyName}`, status: 'success' });
    }
    setCopyOpen(false);
  }

  async function handleDeleteFromMenu(): Promise<void> {
    if (!menuNode) return;
    const ok = await tauriConfirm(`Delete "${menuNode.name}"?`, { title: 'Confirm deletion', kind: 'warning' });
    if (ok) {
      const success = await deleteNode(menuNode.path);
      if (!success) {
        setAlert({ show: true, title: 'Error', description: `Failed to delete ${menuNode.name}`, status: 'error' });
      }
    }
    closeContextMenu();
  }

  async function handleReveal(): Promise<void> {
    if (!menuNode) return;
    try {
      const opener = await import('@tauri-apps/plugin-opener');
      await opener.revealItemInDir(menuNode.path);
    } catch { /* ignore */ }
    closeContextMenu();
  }

  async function handleCopyPath(): Promise<void> {
    if (!menuNode) return;
    try { await navigator.clipboard.writeText(menuNode.path); } catch { /* ignore */ }
    closeContextMenu();
  }

  async function handleNewFile(): Promise<void> {
    if (!menuNode || menuNode.type !== 'directory') return;
    const name = 'new-file.txt';
    const createdPath = await createFileOrDirectory(menuNode.path, name, false);
    if (createdPath && onFileSelect) {
      onFileSelect(createdPath);
    }
    closeContextMenu();
  }

  async function handleNewFolder(): Promise<void> {
    if (!menuNode || menuNode.type !== 'directory') return;
    const name = 'new-folder';
    await createFileOrDirectory(menuNode.path, name, true);
    closeContextMenu();
  }

  return {
    // Context menu state
    menuOpen,
    setMenuOpen,
    menuPos,
    menuNode,
    openContextMenu,
    closeContextMenu,

    // Rename state
    renameOpen,
    setRenameOpen,
    renameName,
    setRenameName,
    renameInputRef,
    beginRename,
    confirmRename,

    // Copy state
    copyOpen,
    setCopyOpen,
    copyName,
    setCopyName,
    copyInputRef,
    beginCopy,
    confirmCopy,

    // Actions
    handleDeleteFromMenu,
    handleReveal,
    handleCopyPath,
    handleNewFile,
    handleNewFolder,
  };
}
