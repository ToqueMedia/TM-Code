import { invoke } from '@/utils/invokeMetrics';
import type { FileTreeNode, FileTreeFilter, FileOperationResult } from '../types/fileTree';

export class FileTreeService {
  static async buildFileTree(rootPath: string, filter?: FileTreeFilter): Promise<FileTreeNode> {
    return await invoke<FileTreeNode>('build_file_tree', { rootPath, filter });
  }

  static async createFileOrDirectory(parentPath: string, name: string, isDirectory: boolean): Promise<FileOperationResult> {
    return await invoke<FileOperationResult>('create_file_or_directory', { parentPath, name, isDirectory });
  }

  static async deleteFileOrDirectory(path: string): Promise<FileOperationResult> {
    return await invoke<FileOperationResult>('delete_file_or_directory', { path });
  }

  static async renameFileOrDirectory(oldPath: string, newName: string): Promise<FileOperationResult> {
    return await invoke<FileOperationResult>('rename_file_or_directory', { oldPath, newName });
  }

  static async copyFileOrDirectory(sourcePath: string, destinationPath: string): Promise<FileOperationResult> {
    return await invoke<FileOperationResult>('copy_file_or_directory', { sourcePath, destinationPath });
  }

  static async createDirectoriesAll(path: string): Promise<FileOperationResult> {
    return await invoke<FileOperationResult>('create_directories_all', { path });
  }
}
