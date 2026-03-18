import { invoke } from '@tauri-apps/api/core';
import { logger } from '../utils/logger';

export interface RunningContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  created: string;
}

export interface ContainerInfo {
  containerId: string;
  containerName: string;
  projectId: string;
  projectPath: string;
  status: string;
  image: string;
}

export interface DevcontainerConfig {
  name?: string;
  image?: string;
  build?: { dockerfile: string; context?: string };
  forwardPorts?: number[];
  containerEnv?: Record<string, string>;
  workspaceFolder?: string;
  postCreateCommand?: string | string[];
  postStartCommand?: string | string[];
  remoteUser?: string;
}

export default class ContainerService {
  static shared = new ContainerService();

  async checkDockerAvailable(): Promise<boolean> {
    try {
      return await invoke<boolean>('check_docker_available');
    } catch (error) {
      logger.warn('container', 'Docker availability check failed:', error);
      return false;
    }
  }

  async createContainer(
    projectId: string,
    projectPath: string,
    image?: string
  ): Promise<ContainerInfo> {
    try {
      return await invoke<ContainerInfo>('create_project_container', {
        projectId,
        projectPath,
        image,
      });
    } catch (error) {
      logger.error('container', 'Failed to create container:', error);
      throw new Error(`Failed to create container: ${error}`);
    }
  }

  async stopContainer(projectId: string): Promise<boolean> {
    try {
      return await invoke<boolean>('stop_project_container', { projectId });
    } catch (error) {
      logger.error('container', 'Failed to stop container:', error);
      throw new Error(`Failed to stop container: ${error}`);
    }
  }

  async removeContainer(projectId: string): Promise<boolean> {
    try {
      return await invoke<boolean>('remove_project_container', { projectId });
    } catch (error) {
      logger.error('container', 'Failed to remove container:', error);
      throw new Error(`Failed to remove container: ${error}`);
    }
  }

  async getContainerStatus(projectId: string): Promise<ContainerInfo | null> {
    try {
      return await invoke<ContainerInfo | null>('get_container_status', { projectId });
    } catch (error) {
      logger.error('container', 'Failed to get container status:', error);
      return null;
    }
  }

  async getActiveContainerInfo(): Promise<ContainerInfo | null> {
    try {
      return await invoke<ContainerInfo | null>('get_active_container_info');
    } catch (error) {
      logger.error('container', 'Failed to get active container info:', error);
      return null;
    }
  }

  async setActiveProject(projectId: string, projectPath: string): Promise<void> {
    try {
      await invoke('set_active_project', { projectId, projectPath });
    } catch (error) {
      logger.error('container', 'Failed to set active project:', error);
      throw new Error(`Failed to set active project: ${error}`);
    }
  }

  async clearActiveProject(projectId: string): Promise<void> {
    try {
      await invoke('clear_active_project', { projectId });
    } catch (error) {
      logger.warn('container', 'Failed to clear active project:', error);
    }
  }

  async detectDevcontainer(projectPath: string): Promise<DevcontainerConfig | null> {
    try {
      return await invoke<DevcontainerConfig | null>('detect_devcontainer', { projectPath });
    } catch (error) {
      logger.warn('container', 'Failed to detect devcontainer config:', error);
      return null;
    }
  }

  async listRunningContainers(): Promise<RunningContainer[]> {
    try {
      return await invoke<RunningContainer[]>('list_running_containers');
    } catch (error) {
      logger.warn('container', 'Failed to list running containers:', error);
      return [];
    }
  }

  async attachToContainer(
    containerName: string,
    projectId: string,
    projectPath: string
  ): Promise<ContainerInfo> {
    try {
      return await invoke<ContainerInfo>('attach_to_container', {
        containerName,
        projectId,
        projectPath,
      });
    } catch (error) {
      logger.error('container', 'Failed to attach to container:', error);
      throw new Error(`Failed to attach to container: ${error}`);
    }
  }

  async isAttachedContainer(): Promise<boolean> {
    try {
      return await invoke<boolean>('is_attached_container');
    } catch {
      return false;
    }
  }

  async cleanupOrphanedContainers(excludeProjectId?: string): Promise<number> {
    try {
      return await invoke<number>('cleanup_orphaned_containers', {
        excludeProjectId: excludeProjectId ?? null,
      });
    } catch (error) {
      logger.warn('container', 'Failed to cleanup orphaned containers:', error);
      return 0;
    }
  }
}
