import { invoke } from '@tauri-apps/api/core';
import { logger } from '../utils/logger';

export interface FileContent {
  path: string;
  content: string;
}

// Per-file write lock — prevents concurrent writes to the same file
// (auto-save + manual save + formatter racing).
const writeLocks = new Map<string, Promise<void>>();

export class FileService {
  static async readFile(path: string): Promise<string> {
    try {
      const response = await invoke<string>('read_file', { path });
      return response;
    } catch (error) {
      logger.error('file', 'Error reading file:', error);
      throw error;
    }
  }

  static async writeFile(path: string, content: string): Promise<void> {
    // Wait for any in-flight write to the same path to complete
    const existing = writeLocks.get(path);
    const doWrite = async () => {
      if (existing) await existing.catch(() => {});
      await invoke<void>('write_file', { path, content });
    };
    const writePromise = doWrite().catch(error => {
      logger.error('file', 'Error writing file:', error);
      throw error;
    }).finally(() => {
      // Only clean up if this is still the latest write
      if (writeLocks.get(path) === writePromise) writeLocks.delete(path);
    });
    writeLocks.set(path, writePromise);
    return writePromise;
  }

  static async createFile(path: string, content: string = ''): Promise<void> {
    try {
      await invoke<void>('create_file', { path, content });
    } catch (error) {
      logger.error('file', 'Error creating file:', error);
      throw error;
    }
  }

  static async deleteFile(path: string): Promise<void> {
    try {
      await invoke<void>('delete_file', { path });
    } catch (error) {
      logger.error('file', 'Error deleting file:', error);
      throw error;
    }
  }
}