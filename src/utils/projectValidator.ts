// src/utils/projectValidator.ts
import { ProjectService } from '../services/projectService';

export class ProjectValidator {
  static async validateProjectPath(path: string): Promise<{ valid: boolean; error?: string }> {
    return await ProjectService.validateProjectPath(path);
  }
  
  static async validateProjectName(name: string): Promise<{ valid: boolean; error?: string }> {
    return await ProjectService.validateProjectName(name);
  }
  
  static async validateProjectLocation(location: string): Promise<{ valid: boolean; error?: string }> {
    return await ProjectService.validateProjectLocation(location);
  }
}