import { invoke } from '@/utils/invokeMetrics';

export interface GitLineChange {
  kind: 'added' | 'modified' | 'removed';
  start_line: number;
  line_count: number;
}

export interface GitFileStatus {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
}

export class GitService {
  static async getDiffLines(filePath: string): Promise<GitLineChange[]> {
    try {
      return await invoke<GitLineChange[]>('git_diff_lines', { filePath });
    } catch (err) {
      console.warn('[GitService] getDiffLines failed:', err);
      return [];
    }
  }

  static async getStatusFiles(projectPath: string): Promise<GitFileStatus[]> {
    try {
      return await invoke<GitFileStatus[]>('git_status_files', { projectPath });
    } catch {
      return [];
    }
  }

  private static async run<T = void>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const raw = String(e);
      // Strip "git" prefix noise and keep the meaningful part
      const clean = raw.replace(/^(Failed to run |git \w+ failed: )/, '').trim();
      throw new Error(`${label}: ${clean || raw}`);
    }
  }

  static async stageFile(projectPath: string, filePath: string): Promise<void> {
    return this.run('Stage', () => invoke('git_stage_file', { projectPath, filePath }));
  }

  static async stageAll(projectPath: string): Promise<void> {
    return this.run('Stage all', () => invoke('git_stage_all', { projectPath }));
  }

  static async unstageFile(projectPath: string, filePath: string): Promise<void> {
    return this.run('Unstage', () => invoke('git_unstage_file', { projectPath, filePath }));
  }

  static async unstageAll(projectPath: string): Promise<void> {
    return this.run('Unstage all', () => invoke('git_unstage_all', { projectPath }));
  }

  static async discardFile(projectPath: string, filePath: string): Promise<void> {
    return this.run('Discard', () => invoke('git_discard_file', { projectPath, filePath }));
  }

  static async discardAll(projectPath: string): Promise<void> {
    return this.run('Discard all', () => invoke('git_discard_all', { projectPath }));
  }

  static async commit(projectPath: string, message: string): Promise<string> {
    return this.run('Commit', () => invoke<string>('git_commit', { projectPath, message }));
  }

  static async showFile(projectPath: string, filePath: string): Promise<string> {
    try {
      return await invoke<string>('git_show_file', { projectPath, filePath });
    } catch {
      return '';
    }
  }

  static async getCurrentBranch(projectPath: string): Promise<string> {
    try {
      return await invoke<string>('git_current_branch', { projectPath });
    } catch {
      return 'main';
    }
  }

  static async push(projectPath: string, remote?: string, branch?: string): Promise<string> {
    return this.run('Push', () => invoke<string>('git_push', { projectPath, remote: remote ?? null, branch: branch ?? null }));
  }

  static async pull(projectPath: string, remote?: string, branch?: string): Promise<string> {
    return this.run('Pull', () => invoke<string>('git_pull', { projectPath, remote: remote ?? null, branch: branch ?? null }));
  }
}
