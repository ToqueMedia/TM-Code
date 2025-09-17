import { invoke } from '@tauri-apps/api/core';

export interface FileContent {
  path: string;
  content: string;
}

export class FileService {
  static async readFile(path: string): Promise<string> {
    try {
      const response = await invoke<string>('read_file', { path });
      return response;
    } catch (error) {
      console.error('Error reading file:', error);
      throw error;
    }
  }

  static async writeFile(path: string, content: string): Promise<void> {
    try {
      await invoke<void>('write_file', { path, content });
    } catch (error) {
      console.error('Error writing file:', error);
      throw error;
    }
  }

  static async createFile(path: string, content: string = ''): Promise<void> {
    try {
      await invoke<void>('create_file', { path, content });
    } catch (error) {
      console.error('Error creating file:', error);
      throw error;
    }
  }

  static async deleteFile(path: string): Promise<void> {
    try {
      await invoke<void>('delete_file', { path });
    } catch (error) {
      console.error('Error deleting file:', error);
      throw error;
    }
  }
}