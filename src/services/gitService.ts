import { invoke } from '@tauri-apps/api/core';

export interface GitLineChange {
  kind: 'added' | 'modified' | 'removed';
  start_line: number;
  line_count: number;
}

export class GitService {
  static async getDiffLines(filePath: string): Promise<GitLineChange[]> {
    try {
      return await invoke<GitLineChange[]>('git_diff_lines', { filePath });
    } catch {
      return [];
    }
  }

  static async getCurrentBranch(projectPath: string): Promise<string> {
    try {
      return await invoke<string>('git_current_branch', { projectPath });
    } catch {
      return 'main';
    }
  }
}
