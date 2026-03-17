import { invoke } from '@tauri-apps/api/core'
import { useProjectStore } from '../stores/projectStore'
import { useToastStore } from '../stores/toastStore'
import { logger } from './logger'

export interface ProjectStatus {
  exists: boolean
  permissionsChanged: boolean
  lastModified?: number
}

/**
 * Checks project status only when the user returns to the app (visibility change).
 * Replaces the previous 5-second polling which was wasteful — directory deletion
 * and permission changes are rare events that only matter when the user is active.
 */
export class ProjectStatusMonitor {
  private static instance: ProjectStatusMonitor
  private listening = false
  private handler: (() => void) | null = null

  private constructor() {}

  static getInstance(): ProjectStatusMonitor {
    if (!ProjectStatusMonitor.instance) {
      ProjectStatusMonitor.instance = new ProjectStatusMonitor()
    }
    return ProjectStatusMonitor.instance
  }

  async checkProjectStatus(path: string): Promise<ProjectStatus> {
    try {
      const status: ProjectStatus = await invoke('check_project_status', { path })
      return status
    } catch (error) {
      logger.error('project', 'Failed to check project status:', error)
      return { exists: false, permissionsChanged: false }
    }
  }

  startMonitoring() {
    if (this.listening) return

    this.handler = async () => {
      if (document.visibilityState !== 'visible') return

      const { currentProject } = useProjectStore.getState()
      if (!currentProject) return

      const status = await this.checkProjectStatus(currentProject.path)

      if (!status.exists) {
        logger.warn('project', 'Project directory no longer exists')
        useToastStore.getState().addToast('error', 'Project directory no longer exists. The project has been closed.')
        useProjectStore.getState().closeProject()
      }

      if (status.permissionsChanged) {
        logger.warn('project', 'Project permissions have changed')
        useToastStore.getState().addToast('warning', 'Project directory permissions have changed. Some operations may fail.')
      }
    }

    document.addEventListener('visibilitychange', this.handler)
    this.listening = true
  }

  stopMonitoring() {
    if (this.handler) {
      document.removeEventListener('visibilitychange', this.handler)
      this.handler = null
    }
    this.listening = false
  }
}
