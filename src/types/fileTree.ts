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
  /**
   * When true, entries matched by the project's `.gitignore` files are omitted
   * (nested .gitignores honoured). Opt-in — defaults to false so the file
   * explorer UI keeps showing ignored files (e.g. `.env`). The agent context
   * tree turns it on to cut noise from generated/ignored paths.
   */
  respectGitignore?: boolean;
}

export interface FileOperationResult {
  success: boolean;
  message: string;
  path: string;
}