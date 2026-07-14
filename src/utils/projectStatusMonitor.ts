import { invoke } from '@/utils/invokeMetrics'
import { useProjectStore } from '../stores/projectStore'
import { useToastStore } from '../stores/toastStore'
import { logger } from './logger'
import { t } from '../i18n'

export interface ProjectStatus {
  exists: boolean
  permissionsChanged: boolean
  lastModified?: number
}

// 20s (was 5s) and focus-gated: deleting an open project is rare enough that
// sub-5s detection buys nothing, and the visibility-change check below already
// covers "it happened while the app was in background" the moment the user
// returns — same playbook as services/gitStatusPoller.ts (2026-06-12).
const POLL_INTERVAL_MS = 20_000

/**
 * Monitors project directory health via two mechanisms:
 * 1. Active polling every 20s, only while the window has focus — detects
 *    deletion while the IDE is in use
 * 2. Visibility-change check — catches changes that happened while the app was in background
 */
export class ProjectStatusMonitor {
  private static instance: ProjectStatusMonitor
  private listening = false
  private visibilityHandler: (() => void) | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null

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

  private async runCheck() {
    const { currentProject } = useProjectStore.getState()
    if (!currentProject) return

    const status = await this.checkProjectStatus(currentProject.path)

    if (!status.exists) {
      logger.warn('project', 'Project directory no longer exists')
      this.stopMonitoring()
      useToastStore.getState().addToast('error', t('project.directoryDeleted'))
      // force: no confirms — the directory is GONE and monitoring already
      // stopped, so a declined modal would strand the app on a nonexistent
      // project with no re-check ever firing.
      void useProjectStore.getState().closeProject({ force: true })
      return
    }

    if (status.permissionsChanged) {
      logger.warn('project', 'Project permissions have changed')
      useToastStore.getState().addToast('warning', t('project.permissionsChanged'))
    }
  }

  startMonitoring() {
    if (this.listening) return

    // Active polling — detects deletion while IDE is focused. Skipped while
    // the window is unfocused; the visibilitychange handler below runs an
    // immediate check on return, so nothing is missed.
    this.pollTimer = setInterval(() => {
      if (document.hasFocus()) this.runCheck()
    }, POLL_INTERVAL_MS)

    // Visibility change — immediate check when user returns to the app
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.runCheck()
      }
    }
    document.addEventListener('visibilitychange', this.visibilityHandler)

    this.listening = true
  }

  stopMonitoring() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
    this.listening = false
  }
}
