// src/utils/projectValidator.ts

export class ProjectValidator {
  static async validateProjectPath(path: string): Promise<{ valid: boolean; error?: string }> {
    try {
      // In a real implementation, we would call a Tauri command to validate the path
      // For now, we'll simulate this with a simple check
      if (!path || path.trim() === '') {
        return { valid: false, error: 'Project path is required' };
      }
      
      // Check if path exists and is accessible
      // This would be implemented as a Tauri command in a real application
      // const result = await invoke('validate_project_path', { path });
      
      // Simulate validation result
      return { valid: true };
    } catch (error: any) {
      return { valid: false, error: error.message || 'Failed to validate project path' };
    }
  }
  
  static async validateProjectName(name: string): Promise<{ valid: boolean; error?: string }> {
    if (!name || name.trim() === '') {
      return { valid: false, error: 'Project name is required' };
    }
    
    // Check for invalid characters
    if (!/^[a-zA-Z0-9-_]+$/.test(name)) {
      return { valid: false, error: 'Project name can only contain letters, numbers, hyphens, and underscores' };
    }
    
    // Check length
    if (name.length > 100) {
      return { valid: false, error: 'Project name is too long' };
    }
    
    return { valid: true };
  }
  
  static async validateProjectLocation(location: string): Promise<{ valid: boolean; error?: string }> {
    if (!location || location.trim() === '') {
      return { valid: false, error: 'Project location is required' };
    }
    
    // Check if location exists and is writable
    // This would be implemented as a Tauri command in a real application
    // const result = await invoke('validate_project_location', { location });
    
    // Simulate validation result
    return { valid: true };
  }
}