import { invoke } from '@/utils/invokeMetrics';
import type { ProjectInfo, RecentProject, ProjectState, ProjectTemplate } from '../types/project';
import { logger } from '../utils/logger';

export class ProjectService {
  static async openProject(path: string): Promise<ProjectInfo> {
    try {
      const response = await invoke<ProjectInfo>('open_project', { path });
      return response;
    } catch (error) {
      logger.error('project', 'Error opening project:', error);
      throw error;
    }
  }

  static async createProject(path: string, template: ProjectTemplate): Promise<ProjectInfo> {
    try {
      const response = await invoke<ProjectInfo>('create_project', { path, template });
      return response;
    } catch (error) {
      logger.error('project', 'Error creating project:', error);
      throw error;
    }
  }

  static async getRecentProjects(): Promise<RecentProject[]> {
    try {
      const response = await invoke<RecentProject[]>('get_recent_projects');
      return response;
    } catch (error) {
      logger.error('project', 'Error getting recent projects:', error);
      throw error;
    }
  }

  static async saveProjectState(projectId: string, state: ProjectState): Promise<void> {
    try {
      await invoke<void>('save_project_state', { projectId, state });
    } catch (error) {
      logger.error('project', 'Error saving project state:', error);
      throw error;
    }
  }

  static async loadProjectState(projectId: string): Promise<ProjectState> {
    try {
      const response = await invoke<ProjectState>('load_project_state', { projectId });
      return response;
    } catch (error) {
      logger.error('project', 'Error loading project state:', error);
      throw error;
    }
  }

  static async validateProjectPath(path: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await invoke<{ valid: boolean; error: string | null }>('validate_project_path', { path });
      return {
        valid: response.valid,
        error: response.error || undefined
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        return { valid: false, error: error.message || 'Failed to validate project path' };
      }
      return { valid: false, error: 'Failed to validate project path' };
    }
  }

  static async validateProjectName(name: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await invoke<{ valid: boolean; error: string | null }>('validate_project_name', { name });
      return {
        valid: response.valid,
        error: response.error || undefined
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        return { valid: false, error: error.message || 'Failed to validate project name' };
      }
      return { valid: false, error: 'Failed to validate project name' };
    }
  }

  static async validateProjectLocation(location: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await invoke<{ valid: boolean; error: string | null }>('validate_project_location', { location });
      return {
        valid: response.valid,
        error: response.error || undefined
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        return { valid: false, error: error.message || 'Failed to validate project location' };
      }
      return { valid: false, error: 'Failed to validate project location' };
    }
  }

  static async checkProjectStatus(path: string): Promise<{ exists: boolean; permissionsChanged: boolean; lastModified?: number }> {
    try {
      const response = await invoke<{ exists: boolean; permissionsChanged: boolean; lastModified: number | null }>('check_project_status', { path });
      return {
        exists: response.exists,
        permissionsChanged: response.permissionsChanged,
        lastModified: response.lastModified || undefined
      };
    } catch (error) {
      logger.error('project', 'Error checking project status:', error);
      throw error;
    }
  }
}