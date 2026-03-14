// src/utils/projectStatusMonitor.ts
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../stores/projectStore';
import { logger } from './logger';

export interface ProjectStatus {
  exists: boolean;
  permissionsChanged: boolean;
  lastModified?: number;
}

export class ProjectStatusMonitor {
  private static instance: ProjectStatusMonitor;
  private intervalId: number | null = null;
  private checkInterval = 5000; // 5 seconds

  private constructor() {}

  static getInstance(): ProjectStatusMonitor {
    if (!ProjectStatusMonitor.instance) {
      ProjectStatusMonitor.instance = new ProjectStatusMonitor();
    }
    return ProjectStatusMonitor.instance;
  }

  async checkProjectStatus(path: string): Promise<ProjectStatus> {
    try {
      const status: ProjectStatus = await invoke('check_project_status', { path });
      return status;
    } catch (error) {
      logger.error('project', 'Failed to check project status:', error);
      return {
        exists: false,
        permissionsChanged: false
      };
    }
  }

  startMonitoring() {
    // Clear any existing interval
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    // Start monitoring
    this.intervalId = window.setInterval(async () => {
      const { currentProject } = useProjectStore.getState();
      if (currentProject) {
        const status = await this.checkProjectStatus(currentProject.path);
        
        // Handle project deletion
        if (!status.exists) {
          logger.warn('project', 'Project directory no longer exists');
          // Show notification to user and close project
          this.showNotification('Project directory no longer exists. Closing project.', 'error');
          useProjectStore.getState().closeProject();
        }
        
        // Handle permission changes
        if (status.permissionsChanged) {
          logger.warn('project', 'Project permissions have changed');
          // Show notification to user
          this.showNotification('Project permissions have changed. Some operations may be restricted.', 'warning');
        }
      }
    }, this.checkInterval);
  }

  stopMonitoring() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private showNotification(message: string, type: 'info' | 'warning' | 'error') {
    // In a real implementation, we would use a proper notification system
    // For now, we'll just show an alert
    logger.info('project', `[${type.toUpperCase()}] ${message}`);
    
    // You can replace this with a proper notification system like:
    // - Toast notifications
    // - Status bar messages
    // - Dialog boxes
  }
}