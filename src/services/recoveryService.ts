import { ProjectService } from './projectService';
import type { ProjectState } from '../types/project';
import { logger } from '../utils/logger';

class RecoveryService {
  private static instance: RecoveryService;
  private recoveryStates: Map<string, ProjectState> = new Map();
  private recoveryInterval: number | null = null;
  private readonly MAX_CACHED_STATES = 10;

  private constructor() {}

  static getInstance(): RecoveryService {
    if (!RecoveryService.instance) {
      RecoveryService.instance = new RecoveryService();
    }
    return RecoveryService.instance;
  }

  private enforceCacheLimit(): void {
    while (this.recoveryStates.size > this.MAX_CACHED_STATES) {
      // Remove oldest entry (first key in insertion order)
      const firstKey = this.recoveryStates.keys().next().value;
      if (firstKey !== undefined) {
        this.recoveryStates.delete(firstKey);
      } else {
        break;
      }
    }
  }

  async saveRecoveryState(projectId: string, state: ProjectState): Promise<void> {
    try {
      const recoveryKey = `recovery_${projectId}`;
      localStorage.setItem(recoveryKey, JSON.stringify(state));

      this.recoveryStates.set(projectId, state);
      this.enforceCacheLimit();
    } catch (error: unknown) {
      logger.error('recovery', `Failed to save recovery state for project ${projectId}:`, error);
    }
  }

  async loadRecoveryState(projectId: string): Promise<ProjectState | null> {
    try {
      if (this.recoveryStates.has(projectId)) {
        return this.recoveryStates.get(projectId) || null;
      }

      const recoveryKey = `recovery_${projectId}`;
      const recoveryState = localStorage.getItem(recoveryKey);
      if (recoveryState) {
        try {
          const state = JSON.parse(recoveryState) as ProjectState;
          this.recoveryStates.set(projectId, state);
          this.enforceCacheLimit();
          return state;
        } catch {
          // Corrupted data — remove it
          localStorage.removeItem(recoveryKey);
          return null;
        }
      }

      return null;
    } catch (error: unknown) {
      logger.error('recovery', `Failed to load recovery state for project ${projectId}:`, error);
      return null;
    }
  }

  async clearRecoveryState(projectId: string): Promise<void> {
    try {
      this.recoveryStates.delete(projectId);

      const recoveryKey = `recovery_${projectId}`;
      localStorage.removeItem(recoveryKey);
    } catch (error: unknown) {
      logger.error('recovery', `Failed to clear recovery state for project ${projectId}:`, error);
    }
  }

  async hasRecoveryState(projectId: string): Promise<boolean> {
    try {
      const recoveryKey = `recovery_${projectId}`;
      return this.recoveryStates.has(projectId) || !!localStorage.getItem(recoveryKey);
    } catch (error: unknown) {
      logger.error('recovery', `Failed to check recovery state for project ${projectId}:`, error);
      return false;
    }
  }

  startRecoveryMonitoring() {
    // No-op: periodic recovery monitoring is not needed since recovery state
    // is saved synchronously during project state saves.
    this.stopRecoveryMonitoring();
  }

  stopRecoveryMonitoring() {
    if (this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
      this.recoveryInterval = null;
    }
  }

  async recoverProject(projectId: string): Promise<boolean> {
    try {
      const recoveryState = await this.loadRecoveryState(projectId);
      if (recoveryState) {
        await ProjectService.saveProjectState(projectId, recoveryState);
        await this.clearRecoveryState(projectId);
        return true;
      }

      return false;
    } catch (error: unknown) {
      logger.error('recovery', `Failed to recover project ${projectId}:`, error);
      return false;
    }
  }

  async checkAndRecoverProject(projectId: string): Promise<boolean> {
    try {
      const hasRecovery = await this.hasRecoveryState(projectId);
      if (hasRecovery) {
        return await this.recoverProject(projectId);
      }

      return false;
    } catch (error: unknown) {
      logger.error('recovery', `Failed to check and recover project ${projectId}:`, error);
      return false;
    }
  }
}

export default RecoveryService;
