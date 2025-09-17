export interface FileMetadata {
  size: number;
  created: string;
  modified: string;
  isHidden: boolean;
  permissions: string;
}

export interface FileTreeNode {
  type: 'directory' | 'file';
  name: string;
  path: string;
  extension?: string;
  metadata: FileMetadata;
  children?: FileTreeNode[];
  expanded?: boolean;
}

export interface FileTreeFilter {
  showHidden: boolean;
  extensions?: string[];
  maxDepth?: number;
}

export interface FileOperationResult {
  success: boolean;
  message: string;
  path: string;
}