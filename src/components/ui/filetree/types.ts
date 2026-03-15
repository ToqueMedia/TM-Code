import type { FileTreeNode } from '@/types/fileTree';

export interface FileTreeProps {
  rootPath: string;
  onFileSelect?: (path: string) => void;
  onRefresh?: () => void;
}

export interface AlertState {
  show: boolean;
  title: string;
  description: string;
  status: 'success' | 'error';
}

export interface TreeNodeProps {
  node: FileTreeNode;
  level: number;
  onFileSelect?: (path: string) => void;
  setAlert: (alert: AlertState) => void;
  onOpenContextMenu?: (node: FileTreeNode, pos: { x: number; y: number }) => void;
}

export type FlatItem = { node: FileTreeNode; level: number };
