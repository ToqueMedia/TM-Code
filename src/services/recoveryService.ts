import { ProjectService } from './projectService';
import type { ProjectState } from '../types/project';

class RecoveryService {
  private static instance: RecoveryService;
  private recoveryStates: Map<string, ProjectState> = new Map();
  private recoveryInterval: number | null = null;
  private readonly RECOVERY_INTERVAL = 30000; // 30 seconds

  private constructor() {}

  static getInstance(): RecoveryService {
    if (!RecoveryService.instance) {
      RecoveryService.instance = new RecoveryService();
    }
    return RecoveryService.instance;
  }

  async saveRecoveryState(projectId: string, state: ProjectState): Promise<void> {
    try {
      // Save to a separate recovery file
      const recoveryKey = `recovery_${projectId}`;
      localStorage.setItem(recoveryKey, JSON.stringify(state));
      
      // Also keep in memory for quick access
      this.recoveryStates.set(projectId, state);
      
      console.log(`Recovery state saved for project ${projectId}`);
    } catch (error: unknown) {
      console.error(`Failed to save recovery state for project ${projectId}:`, error);
    }
  }

  async loadRecoveryState(projectId: string): Promise<ProjectState | null> {
    try {
      // First check memory cache
      if (this.recoveryStates.has(projectId)) {
        return this.recoveryStates.get(projectId) || null;
      }
      
      // Then check localStorage
      const recoveryKey = `recovery_${projectId}`;
      const recoveryState = localStorage.getItem(recoveryKey);
      if (recoveryState) {
        const state = JSON.parse(recoveryState);
        // Cache in memory for future access
        this.recoveryStates.set(projectId, state);
        return state;
      }
      
      return null;
    } catch (error: unknown) {
      console.error(`Failed to load recovery state for project ${projectId}:`, error);
      return null;
    }
  }

  async clearRecoveryState(projectId: string): Promise<void> {
    try {
      // Remove from memory
      this.recoveryStates.delete(projectId);
      
      // Remove from localStorage
      const recoveryKey = `recovery_${projectId}`;
      localStorage.removeItem(recoveryKey);
      
      console.log(`Recovery state cleared for project ${projectId}`);
    } catch (error: unknown) {
      console.error(`Failed to clear recovery state for project ${projectId}:`, error);
    }
  }

  async hasRecoveryState(projectId: string): Promise<boolean> {
    try {
      const recoveryKey = `recovery_${projectId}`;
      return this.recoveryStates.has(projectId) || !!localStorage.getItem(recoveryKey);
    } catch (error: unknown) {
      console.error(`Failed to check recovery state for project ${projectId}:`, error);
      return false;
    }
  }

  startRecoveryMonitoring() {
    // Clear any existing interval
    if (this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
    }
    
    // Start monitoring
    this.recoveryInterval = window.setInterval(() => {
      // This could be used to periodically check for recovery states
      // or perform other recovery-related tasks
      console.log('Recovery monitoring tick');
    }, this.RECOVERY_INTERVAL);
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
        // Save the recovery state as the current project state
        await ProjectService.saveProjectState(projectId, recoveryState);
        
        // Clear the recovery state since we've recovered
        await this.clearRecoveryState(projectId);
        
        console.log(`Project ${projectId} recovered successfully`);
        return true;
      }
      
      console.log(`No recovery state found for project ${projectId}`);
      return false;
    } catch (error: unknown) {
      console.error(`Failed to recover project ${projectId}:`, error);
      return false;
    }
  }

  async checkAndRecoverProject(projectId: string): Promise<boolean> {
    try {
      const hasRecovery = await this.hasRecoveryState(projectId);
      if (hasRecovery) {
        console.log(`Recovery state found for project ${projectId}. Attempting recovery...`);
        return await this.recoverProject(projectId);
      }
      
      return false;
    } catch (error: unknown) {
      console.error(`Failed to check and recover project ${projectId}:`, error);
      return false;
    }
  }
}

export default RecoveryService;